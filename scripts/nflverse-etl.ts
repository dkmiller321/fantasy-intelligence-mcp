/**
 * nflverse -> D1: schedules (with betting lines and roof) and weekly player stats
 * including IDP.
 *
 * Runs in Node under GitHub Actions or locally, never in the Worker (DECISIONS D13).
 *
 *   npm run etl -- --seasons 2025,2026 --remote
 */

import { toSleeperStatLine, toUsage } from "../src/engine/nflverse-map";
import { scoreStatLine } from "../src/engine/scoring";
import { normalizePosition, normalizeTeam } from "../src/ids/normalize";
import { csvToObjects, fetchText, loadRows, naToNull, parseArgs, sql } from "./lib/d1";

const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const SLEEPER_LEAGUE = "https://api.sleeper.app/v1/league";

function n(row: Readonly<Record<string, string>>, key: string): number | null {
  const raw = naToNull(row[key]);
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Implied team totals from the market. spread_line is nflverse's home-team line, where a
 * positive value means the home team is favoured by that many points.
 */
function impliedTotals(
  spread: number | null,
  total: number | null,
): { home: number | null; away: number | null } {
  if (spread === null || total === null) return { home: null, away: null };
  return { home: total / 2 + spread / 2, away: total / 2 - spread / 2 };
}

async function loadGames(seasons: readonly number[], db: string, remote: boolean): Promise<number> {
  const csv = await fetchText(`${RELEASE}/schedules/games.csv`, "games.csv");
  const all = csvToObjects(csv);
  const wanted = new Set(seasons.map(String));
  const rows: string[] = [];
  const now = new Date().toISOString();

  for (const g of all) {
    if (!wanted.has(g.season ?? "")) continue;
    const gameId = naToNull(g.game_id);
    const home = normalizeTeam(naToNull(g.home_team));
    const away = normalizeTeam(naToNull(g.away_team));
    if (!gameId || !home || !away) continue;

    const spread = n(g, "spread_line");
    const total = n(g, "total_line");
    const implied = impliedTotals(spread, total);
    const day = naToNull(g.gameday);
    const time = naToNull(g.gametime);
    // Kickoff times are US Eastern; recorded as a naive local timestamp and treated as
    // Eastern downstream rather than pretending to a precision the file does not have.
    const kickoff = day ? `${day}T${time ?? "13:00"}:00` : null;

    rows.push(
      `INSERT INTO games (id, season, week, kickoff, home, away, roof, surface, venue_name,
         spread, total, implied_home, implied_away, odds_as_of, temp_f, wind_mph, fetched_at)
       VALUES (${sql(gameId)}, ${Number(g.season)}, ${Number(g.week)}, ${sql(kickoff)},
         ${sql(home)}, ${sql(away)}, ${sql(naToNull(g.roof))}, ${sql(naToNull(g.surface))},
         ${sql(naToNull(g.stadium_id))}, ${sql(spread)}, ${sql(total)},
         ${sql(implied.home)}, ${sql(implied.away)}, ${sql(spread !== null ? now : null)},
         ${sql(n(g, "temp"))}, ${sql(n(g, "wind"))}, ${sql(now)})
       ON CONFLICT(id) DO UPDATE SET
         kickoff=excluded.kickoff, roof=excluded.roof, surface=excluded.surface,
         venue_name=excluded.venue_name, spread=excluded.spread, total=excluded.total,
         implied_home=excluded.implied_home, implied_away=excluded.implied_away,
         odds_as_of=excluded.odds_as_of, temp_f=excluded.temp_f, wind_mph=excluded.wind_mph,
         fetched_at=excluded.fetched_at;`.replace(/\s+/g, " "),
    );
  }

  console.log(`  games rows: ${rows.length}`);
  return loadRows(rows, { database: db, remote, label: "games", batchSize: 300 });
}

async function loadWeeklyStats(
  season: number,
  scoring: Record<string, number>,
  db: string,
  remote: boolean,
): Promise<number> {
  const csv = await fetchText(
    `${RELEASE}/stats_player/stats_player_week_${season}.csv`,
    `stats_player_week_${season}.csv`,
  );
  const all = csvToObjects(csv);
  const rows: string[] = [];
  const now = new Date().toISOString();
  let skippedNoId = 0;
  let skippedNoPosition = 0;

  for (const r of all) {
    if (naToNull(r.season_type) !== "REG") continue;
    // canonical_id is the gsis_id for every player nflverse knows about; rows without
    // one cannot be joined to a roster and are dropped rather than guessed at.
    const gsis = naToNull(r.player_id);
    if (!gsis) {
      skippedNoId++;
      continue;
    }
    const position = normalizePosition(naToNull(r.position));
    if (!position) {
      skippedNoPosition++;
      continue;
    }

    const statLine = toSleeperStatLine(r);
    if (Object.keys(statLine).length === 0) continue;

    const points = scoreStatLine(statLine, scoring).points;
    const usage = toUsage(r);
    const week = Number(r.week);
    if (!Number.isFinite(week)) continue;

    rows.push(
      `INSERT INTO player_week_stats (player_id, season, week, opponent, team, stat_line,
         targets, target_share, carries, fetched_at)
       VALUES (${sql(gsis)}, ${season}, ${week}, ${sql(normalizeTeam(naToNull(r.opponent_team)))},
         ${sql(normalizeTeam(naToNull(r.team)))}, ${sql(JSON.stringify({ ...statLine, __pts: points }))},
         ${sql(usage.targets || null)}, ${sql(usage.targetShare || null)},
         ${sql(usage.carries || null)}, ${sql(now)})
       ON CONFLICT(player_id, season, week) DO UPDATE SET
         opponent=excluded.opponent, team=excluded.team, stat_line=excluded.stat_line,
         targets=excluded.targets, target_share=excluded.target_share,
         carries=excluded.carries, fetched_at=excluded.fetched_at;`.replace(/\s+/g, " "),
    );
  }

  console.log(
    `  ${season}: ${rows.length} stat rows (skipped ${skippedNoId} without an id, ` +
      `${skippedNoPosition} non-fantasy positions)`,
  );
  return loadRows(rows, { database: db, remote, label: `stats ${season}`, batchSize: 300 });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const remote = Boolean(args.remote);
  const seasons = String(args.seasons ?? "2025,2026")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((s) => Number.isFinite(s));
  const leagueId = String(args.league ?? "1340893699625717760");
  const db = "fantasy";

  console.log(`nflverse-etl seasons=${seasons.join(",")} (${remote ? "remote" : "local"} D1)`);

  // Historical points are scored by the league's own rules, so a player's past weeks are
  // measured exactly as their next one will be.
  const leagueRes = await fetch(`${SLEEPER_LEAGUE}/${leagueId}`);
  if (!leagueRes.ok) throw new Error(`league fetch failed: ${leagueRes.status}`);
  const scoring = ((await leagueRes.json()) as { scoring_settings: Record<string, number> })
    .scoring_settings;
  console.log(`  scoring keys: ${Object.keys(scoring).length}`);

  const startedAt = new Date().toISOString();
  let total = await loadGames(seasons, db, remote);
  for (const season of seasons) {
    total += await loadWeeklyStats(season, scoring, db, remote);
  }

  loadRows(
    [
      `INSERT INTO ingest_runs (job, started_at, finished_at, status, row_count) VALUES ('nflverse-etl', ${sql(startedAt)}, ${sql(new Date().toISOString())}, 'ok', ${total});`,
    ],
    { database: db, remote, label: "ingest_runs" },
  );
  console.log(`done: ${total} rows`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

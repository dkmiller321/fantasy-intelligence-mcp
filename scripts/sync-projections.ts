/**
 * Sleeper projections -> D1, with points recomputed from the stat line under the
 * league's own scoring (DECISIONS D5, D6).
 *
 *   npm run sync:projections -- --week 1 --remote
 */

import { espnCovers, espnPosition, espnStatsToSleeper } from "../src/engine/espn-map";
import { scoreStatLine } from "../src/engine/scoring";
import { EspnProjectionsProvider } from "../src/providers/espn/projections";
import { PROJECTION_POSITIONS } from "../src/providers/sleeper/projections";
import { loadRows, parseArgs, queryD1, sql } from "./lib/d1";

const PROJ = "https://api.sleeper.app/projections/nfl";
const SLEEPER_LEAGUE = "https://api.sleeper.app/v1/league";

const POSITIONS = PROJECTION_POSITIONS;

interface ProjRow {
  player_id: string;
  week: number | null;
  season: string;
  team: string | null;
  opponent: string | null;
  company: string | null;
  stats: Record<string, number> | null;
}

async function fetchPosition(season: number, week: number, position: string): Promise<ProjRow[]> {
  const url = `${PROJ}/${season}/${week}?season_type=regular&position[]=${position}&order_by=ppr`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ProjRow[];
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  return [];
}

function projectionRow(
  canonicalId: string,
  season: number,
  week: number,
  source: string,
  points: number,
  statLine: Record<string, number>,
  opponent: string | null,
  now: string,
): string {
  return `INSERT INTO projections (player_id, season, week, source, scoring_format, points,
       stat_line, opponent, as_of)
     VALUES (${sql(canonicalId)}, ${season}, ${sql(String(week))}, ${sql(source)}, 'league',
       ${sql(points)}, ${sql(JSON.stringify(statLine))}, ${sql(opponent)}, ${sql(now)})
     ON CONFLICT(player_id, season, week, source) DO UPDATE SET
       points=excluded.points, stat_line=excluded.stat_line,
       opponent=excluded.opponent, as_of=excluded.as_of;`.replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const remote = Boolean(args.remote);
  const leagueId = String(args.league ?? "1340893699625717760");
  const db = "fantasy";

  const stateRes = await fetch("https://api.sleeper.app/v1/state/nfl");
  const state = (await stateRes.json()) as { season: string; week: number };
  const season = Number(args.season ?? state.season);
  const week = Number(args.week ?? state.week);

  console.log(`sync-projections season=${season} week=${week} (${remote ? "remote" : "local"})`);

  const leagueRes = await fetch(`${SLEEPER_LEAGUE}/${leagueId}`);
  const scoring = ((await leagueRes.json()) as { scoring_settings: Record<string, number> })
    .scoring_settings;

  // sleeper_id -> canonical_id, so projections join to everything else.
  const idRows = queryD1<{ sleeper_id: string; canonical_id: string }>(
    db,
    remote,
    "SELECT sleeper_id, canonical_id FROM players WHERE sleeper_id IS NOT NULL",
  );
  const canonical = new Map(idRows.map((r) => [r.sleeper_id, r.canonical_id]));
  console.log(`  id map: ${canonical.size}`);

  const now = new Date().toISOString();
  const rows: string[] = [];
  let withStats = 0;
  let unmapped = 0;

  for (const position of POSITIONS) {
    const raw = await fetchPosition(season, week, position);
    let kept = 0;
    for (const r of raw) {
      const stats = r.stats;
      if (!stats || Object.keys(stats).length <= 2) continue;
      withStats++;

      const canonicalId = canonical.get(r.player_id);
      if (!canonicalId) {
        unmapped++;
        continue;
      }

      // Never trust the provider's own points field; for IDP it is wrong by more than
      // an order of magnitude (DECISIONS D5).
      const points = scoreStatLine(stats, scoring).points;

      rows.push(
        projectionRow(canonicalId, season, week, "sleeper", points, stats, r.opponent, now),
      );
      kept++;
    }
    console.log(`  ${position}: ${kept} projections`);
  }

  console.log(`  sleeper total ${rows.length} (${unmapped} of ${withStats} had no canonical id)`);

  // Second source. ESPN keys on its own player ids, which the crosswalk already carries
  // from the Sleeper sync, so no name matching is involved.
  const espnRows = queryD1<{ external_id: string; canonical_id: string }>(
    db,
    remote,
    "SELECT external_id, canonical_id FROM player_ids WHERE source = 'espn'",
  );
  const byEspnId = new Map(espnRows.map((r) => [r.external_id, r.canonical_id]));
  console.log(`  espn id map: ${byEspnId.size}`);

  try {
    const espn = new EspnProjectionsProvider(() => new Date());
    const projections = await espn.forWeek(season, week, 600);
    let kept = 0;
    let noId = 0;
    let notCovered = 0;

    for (const row of projections) {
      const position = espnPosition(row.positionId);
      if (!position || !espnCovers(position)) {
        notCovered++;
        continue;
      }
      const canonicalId = byEspnId.get(row.espnId);
      if (!canonicalId) {
        noId++;
        continue;
      }
      const line = espnStatsToSleeper(row.stats, scoring);
      if (Object.keys(line).length === 0) continue;

      // Same rule as every other source: recompute against this league's scoring rather
      // than trusting the provider's own total (DECISIONS D5).
      const points = scoreStatLine(line, scoring).points;
      rows.push(projectionRow(canonicalId, season, week, "espn", points, line, null, now));
      kept++;
    }
    console.log(
      `  espn: ${kept} projections (${noId} unmatched ids, ${notCovered} outside its coverage)`,
    );
  } catch (err) {
    // A second source is an upgrade, not a dependency. Losing it costs the confidence
    // lift and nothing else.
    console.log(`  espn: unavailable (${err instanceof Error ? err.message : String(err)})`);
  }

  console.log(`  total rows ${rows.length}`);
  loadRows(rows, { database: db, remote, label: "projections", batchSize: 300 });

  loadRows(
    [
      `INSERT INTO ingest_runs (job, started_at, finished_at, status, row_count) VALUES ('sync-projections', ${sql(now)}, ${sql(new Date().toISOString())}, 'ok', ${rows.length});`,
    ],
    { database: db, remote, label: "ingest_runs" },
  );
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

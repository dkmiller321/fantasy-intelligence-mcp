import { readFileSync } from "node:fs";

/**
 * Sleeper projections -> D1, with points recomputed from the stat line under the
 * league's own scoring (DECISIONS D5, D6).
 *
 *   npm run sync:projections -- --week 1 --remote
 */

import { espnCovers, espnPosition, espnStatsToSleeper } from "../src/engine/espn-map";
import { fantasyProsStatsToSleeper } from "../src/engine/fantasypros-map";
import { scoreStatLine } from "../src/engine/scoring";
import { EspnProjectionsProvider } from "../src/providers/espn/projections";
import { FantasyProsProvider } from "../src/providers/fantasypros/projections";
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

/**
 * The key comes from the environment in CI, or from the gitignored local notes file when
 * run by hand. It is never logged and never committed.
 */
function fantasyProsKey(): string | undefined {
  if (process.env.FANTASYPROS_KEY?.trim()) return process.env.FANTASYPROS_KEY.trim();
  try {
    const line = readFileSync("SECRETS.local.md", "utf8")
      .split(/\r?\n/)
      .find((l) => /fantasypros api key/i.test(l));
    const value = line?.split(":").slice(1).join(":").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
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

  // Third source, and the only one that covers IDP. Optional: absent key means absent
  // provider, and the engine blends whatever else exists (DECISIONS D23).
  const fpKey = fantasyProsKey();
  if (!FantasyProsProvider.isConfigured(fpKey)) {
    console.log("  fantasypros: no key configured, skipped");
  } else {
    const fpRows = queryD1<{ external_id: string; canonical_id: string }>(
      db,
      remote,
      "SELECT external_id, canonical_id FROM player_ids WHERE source = 'fantasypros'",
    );
    const canonicalByFp = new Map(fpRows.map((r) => [r.external_id, r.canonical_id]));
    const fpByCanonical = new Map(fpRows.map((r) => [r.canonical_id, r.external_id]));
    console.log(`  fantasypros id map: ${canonicalByFp.size}`);

    // The quota is small and undocumented, so the request budget is spent where it buys
    // the most: the owner's own roster first, then the top ten at each position, which
    // together cover every player the engine is likely to be asked about.
    const rostered = queryD1<{ canonical_id: string }>(
      db,
      remote,
      `SELECT DISTINCT p.canonical_id FROM teams t
       JOIN players p ON instr(t.player_ids, '"' || p.sleeper_id || '"') > 0
       WHERE t.league_id = '${leagueId}' AND t.team_id = (
         SELECT my_team_id FROM leagues WHERE id = '${leagueId}'
       )`,
    );
    const rosterFpids = rostered
      .map((r) => fpByCanonical.get(r.canonical_id))
      .filter((x): x is string => !!x);

    const fp = new FantasyProsProvider(fpKey, () => new Date());
    let kept = 0;
    let exhausted = false;

    const ingest = (rowsIn: { fpid: string; stats: Record<string, number> }[]) => {
      for (const row of rowsIn) {
        const canonicalId = canonicalByFp.get(row.fpid);
        if (!canonicalId) continue;
        const line = fantasyProsStatsToSleeper(row.stats, scoring);
        if (Object.keys(line).length === 0) continue;
        const points = scoreStatLine(line, scoring).points;
        rows.push(projectionRow(canonicalId, season, week, "fantasypros", points, line, null, now));
        kept++;
      }
    };

    try {
      console.log(`  fantasypros: ${rosterFpids.length} rostered players, batches of 10`);
      const roster = await fp.forPlayers(season, week, rosterFpids);
      ingest(roster.projections);
      exhausted = roster.quotaExhausted;

      if (!exhausted && args["fp-top"] !== "false") {
        const top = await fp.topAcrossPositions(season, week, [...POSITIONS]);
        ingest(top.projections);
        exhausted = top.quotaExhausted;
      }
    } catch (err) {
      console.log(
        `  fantasypros: unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    console.log(
      `  fantasypros: ${kept} projections from ${fp.requestsMade} requests` +
        (exhausted ? " (quota exhausted mid-run; partial data kept)" : ""),
    );
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

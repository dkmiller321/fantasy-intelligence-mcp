/**
 * Sleeper projections -> D1, with points recomputed from the stat line under the
 * league's own scoring (DECISIONS D5, D6).
 *
 *   npm run sync:projections -- --week 1 --remote
 */

import { scoreStatLine } from "../src/engine/scoring";
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
        `INSERT INTO projections (player_id, season, week, source, scoring_format, points,
           stat_line, opponent, as_of)
         VALUES (${sql(canonicalId)}, ${season}, ${sql(String(week))}, 'sleeper', 'league',
           ${sql(points)}, ${sql(JSON.stringify(stats))}, ${sql(r.opponent)}, ${sql(now)})
         ON CONFLICT(player_id, season, week, source) DO UPDATE SET
           points=excluded.points, stat_line=excluded.stat_line,
           opponent=excluded.opponent, as_of=excluded.as_of;`.replace(/\s+/g, " "),
      );
      kept++;
    }
    console.log(`  ${position}: ${kept} projections`);
  }

  console.log(`  total ${rows.length} (${unmapped} of ${withStats} had no canonical id)`);
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

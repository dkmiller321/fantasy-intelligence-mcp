/**
 * nflverse depth charts and snap counts -> D1.
 *
 * Two signals the engine was previously proxying:
 *
 * - Depth chart rank replaces Sleeper's `depth_chart_order` as the waiver "opportunity"
 *   input. A free agent listed first at their spot usually means the player ahead of them
 *   is unavailable, which is the whole reason to bid.
 * - Snap share is the usage signal that matters most for IDP. A linebacker's scoring is
 *   almost entirely a function of how many defensive snaps they play, and nothing in the
 *   weekly stats release carries that.
 *
 *   npm run sync:depth -- --seasons 2025,2026 --remote
 */

import { canonicalFromSleeper } from "../src/ids/canonical";
import { normalizeTeam } from "../src/ids/normalize";
import { csvToObjects, fetchText, loadRows, naToNull, parseArgs, queryD1, sql } from "./lib/d1";

const RELEASE = "https://github.com/nflverse/nflverse-data/releases/download";
const CROSSWALK_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv";

/**
 * Depth charts are published as a time series with several snapshots a day, so the 2026
 * file is 46 MB across half a million rows. Only the newest row per player and position
 * is meaningful; the rest is history nobody queries.
 */
async function loadDepthCharts(season: number, db: string, remote: boolean): Promise<number> {
  const csv = await fetchText(
    `${RELEASE}/depth_charts/depth_charts_${season}.csv`,
    `depth_charts_${season}.csv`,
  );
  const rows = csvToObjects(csv);

  const latest = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const gsis = naToNull(r.gsis_id);
    const posAbb = naToNull(r.pos_abb);
    const dt = naToNull(r.dt);
    if (!gsis || !posAbb || !dt) continue;
    const key = `${gsis}|${posAbb}`;
    const prev = latest.get(key);
    if (!prev || (prev.dt as string) < dt) latest.set(key, r);
  }

  const now = new Date().toISOString();
  const out: string[] = [];
  for (const r of latest.values()) {
    const rank = Number(naToNull(r.pos_rank));
    if (!Number.isFinite(rank)) continue;
    out.push(
      `INSERT INTO depth_charts (player_id, season, team, pos_abb, pos_name, pos_grp, pos_rank, as_of, fetched_at)
       VALUES (${sql(naToNull(r.gsis_id))}, ${season}, ${sql(normalizeTeam(naToNull(r.team)))},
         ${sql(naToNull(r.pos_abb))}, ${sql(naToNull(r.pos_name))}, ${sql(naToNull(r.pos_grp))},
         ${rank}, ${sql(naToNull(r.dt))}, ${sql(now)})
       ON CONFLICT(player_id, season, pos_abb) DO UPDATE SET
         team=excluded.team, pos_name=excluded.pos_name, pos_grp=excluded.pos_grp,
         pos_rank=excluded.pos_rank, as_of=excluded.as_of, fetched_at=excluded.fetched_at;`.replace(
        /\s+/g,
        " ",
      ),
    );
  }

  console.log(`  depth_charts ${season}: ${rows.length} rows -> ${out.length} current entries`);
  return loadRows(out, { database: db, remote, label: `depth ${season}`, batchSize: 300 });
}

/**
 * Snap counts key on Pro Football Reference ids, which neither Sleeper nor the stats
 * release uses, so they are joined through the dynastyprocess crosswalk.
 */
async function loadSnapCounts(
  season: number,
  pfrToCanonical: ReadonlyMap<string, string>,
  db: string,
  remote: boolean,
): Promise<number> {
  const csv = await fetchText(
    `${RELEASE}/snap_counts/snap_counts_${season}.csv`,
    `snap_counts_${season}.csv`,
  );
  const rows = csvToObjects(csv);

  const now = new Date().toISOString();
  const out: string[] = [];
  let unmatched = 0;

  for (const r of rows) {
    if (naToNull(r.game_type) !== "REG") continue;
    const pfr = naToNull(r.pfr_player_id);
    if (!pfr) continue;
    const canonicalId = pfrToCanonical.get(pfr);
    if (!canonicalId) {
      unmatched++;
      continue;
    }
    const week = Number(naToNull(r.week));
    if (!Number.isFinite(week)) continue;

    // A player is either an offensive or a defensive contributor; take whichever side
    // they actually played, so one column serves both without the caller branching.
    const off = Number(naToNull(r.offense_snaps) ?? 0);
    const def = Number(naToNull(r.defense_snaps) ?? 0);
    const offPct = Number(naToNull(r.offense_pct) ?? 0);
    const defPct = Number(naToNull(r.defense_pct) ?? 0);
    const snaps = def > off ? def : off;
    const share = def > off ? defPct : offPct;
    if (!Number.isFinite(snaps) || snaps === 0) continue;

    // Only fills the snap columns; the stat line and points are owned by the weekly
    // stats ETL and must not be overwritten here.
    out.push(
      `UPDATE player_week_stats SET snaps = ${snaps}, snap_share = ${Number.isFinite(share) ? share : "NULL"}, fetched_at = ${sql(now)}
       WHERE player_id = ${sql(canonicalId)} AND season = ${season} AND week = ${week};`.replace(
        /\s+/g,
        " ",
      ),
    );
  }

  console.log(`  snap_counts ${season}: ${out.length} updates (${unmatched} unmatched pfr ids)`);
  return loadRows(out, { database: db, remote, label: `snaps ${season}`, batchSize: 300 });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const remote = Boolean(args.remote);
  const seasons = String(args.seasons ?? "2025,2026")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((s) => Number.isFinite(s));
  const db = "fantasy";

  console.log(`sync-depth-snaps seasons=${seasons.join(",")} (${remote ? "remote" : "local"} D1)`);

  const crosswalk = csvToObjects(await fetchText(CROSSWALK_URL, "db_playerids.csv"));
  const pfrToCanonical = new Map<string, string>();
  for (const r of crosswalk) {
    const pfr = naToNull(r.pfr_id);
    const gsis = naToNull(r.gsis_id);
    const sleeper = naToNull(r.sleeper_id);
    if (!pfr) continue;
    if (gsis) pfrToCanonical.set(pfr, gsis);
    else if (sleeper) pfrToCanonical.set(pfr, canonicalFromSleeper(sleeper));
  }
  console.log(`  pfr id map: ${pfrToCanonical.size}`);

  const startedAt = new Date().toISOString();
  let total = 0;
  for (const season of seasons) {
    total += await loadDepthCharts(season, db, remote);
    total += await loadSnapCounts(season, pfrToCanonical, db, remote);
  }

  // Confirm the join actually landed rather than assuming it did.
  const check = queryD1<{ n: number }>(
    db,
    remote,
    "SELECT COUNT(*) AS n FROM player_week_stats WHERE snaps IS NOT NULL",
  );
  console.log(`  rows now carrying snap counts: ${check[0]?.n ?? 0}`);

  loadRows(
    [
      `INSERT INTO ingest_runs (job, started_at, finished_at, status, row_count) VALUES ('depth-snaps', ${sql(startedAt)}, ${sql(new Date().toISOString())}, 'ok', ${total});`,
    ],
    { database: db, remote, label: "ingest_runs" },
  );
  console.log(`done: ${total} rows`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Recompute defense_vs_position and usage_trends from loaded weekly stats.
 *
 * These are the aggregates a tool call must never compute itself: the free plan allows
 * 10 ms of CPU per request, so the request path reads these rows and does arithmetic on
 * a handful of them (DECISIONS D13).
 *
 *   npm run materialize -- --remote
 */

import type { Position } from "../src/domain/types";
import { defenseVsPosition, usageTrend, type WeekRow } from "../src/engine/aggregate";
import { loadRows, parseArgs, queryD1, sql } from "./lib/d1";

interface StatRow {
  player_id: string;
  season: number;
  week: number;
  opponent: string | null;
  position: string;
  stat_line: string;
  target_share: number | null;
  carries: number | null;
}

function toWeekRows(rows: readonly StatRow[]): WeekRow[] {
  const out: WeekRow[] = [];
  for (const r of rows) {
    let points = 0;
    try {
      points = (JSON.parse(r.stat_line) as { __pts?: number }).__pts ?? 0;
    } catch {
      continue;
    }
    out.push({
      playerId: r.player_id,
      position: r.position as Position,
      season: r.season,
      week: r.week,
      opponent: r.opponent,
      points,
      targetShare: r.target_share,
      carries: r.carries,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const remote = Boolean(args.remote);
  const db = "fantasy";

  const stateRes = await fetch("https://api.sleeper.app/v1/state/nfl");
  const state = (await stateRes.json()) as { season: string; week: number };
  const season = Number(args.season ?? state.season);
  const week = Number(args.week ?? state.week);
  const priorSeason = season - 1;

  console.log(`materialize season=${season} throughWeek=${week} prior=${priorSeason}`);

  const select = (s: number) =>
    `SELECT s.player_id, s.season, s.week, s.opponent, s.stat_line, s.target_share, s.carries, p.position
     FROM player_week_stats s JOIN players p ON p.canonical_id = s.player_id
     WHERE s.season = ${s}`.replace(/\s+/g, " ");

  const currentRows = toWeekRows(queryD1<StatRow>(db, remote, select(season)));
  const priorRows = toWeekRows(queryD1<StatRow>(db, remote, select(priorSeason)));
  console.log(`  ${season}: ${currentRows.length} rows | ${priorSeason}: ${priorRows.length} rows`);

  const dvp = defenseVsPosition(currentRows, priorRows, week);
  console.log(
    `  defense_vs_position rows: ${dvp.length} (prior weight ${dvp[0]?.priorWeight ?? 0})`,
  );

  const now = new Date().toISOString();
  const dvpSql = dvp.map((d) =>
    `INSERT INTO defense_vs_position (team, season, through_week, position, fpa_per_game, rank, window, prior_weight, computed_at)
       VALUES (${sql(d.team)}, ${season}, ${week}, ${sql(d.position)}, ${d.fpaPerGame}, ${d.rank}, ${d.window}, ${d.priorWeight}, ${sql(now)})
       ON CONFLICT(team, season, through_week, position) DO UPDATE SET
         fpa_per_game=excluded.fpa_per_game, rank=excluded.rank, window=excluded.window,
         prior_weight=excluded.prior_weight, computed_at=excluded.computed_at;`.replace(
      /\s+/g,
      " ",
    ),
  );
  loadRows(dvpSql, { database: db, remote, label: "defense_vs_position", batchSize: 300 });

  // Usage trends run on the current season only: a share carried over from last year
  // describes a different depth chart.
  const byPlayer = new Map<string, WeekRow[]>();
  for (const r of currentRows) {
    const list = byPlayer.get(r.playerId) ?? [];
    list.push(r);
    byPlayer.set(r.playerId, list);
  }

  const trendSql: string[] = [];
  for (const [playerId, rows] of byPlayer) {
    const metrics: [string, (r: WeekRow) => number | null | undefined][] = [
      ["target_share", (r) => r.targetShare],
      ["carries", (r) => r.carries],
      ["points", (r) => r.points],
    ];
    for (const [metric, pick] of metrics) {
      const values = rows
        .map((r) => ({ week: r.week, value: pick(r) }))
        .filter((v): v is { week: number; value: number } => typeof v.value === "number");
      const t = usageTrend(playerId, metric, values, week);
      if (!t) continue;
      trendSql.push(
        `INSERT INTO usage_trends (player_id, season, through_week, metric, recent, prior, delta, label, prior_weight, computed_at)
         VALUES (${sql(playerId)}, ${season}, ${week}, ${sql(metric)}, ${t.recent}, ${t.prior}, ${t.delta}, ${sql(t.label)}, 0, ${sql(now)})
         ON CONFLICT(player_id, season, through_week, metric) DO UPDATE SET
           recent=excluded.recent, prior=excluded.prior, delta=excluded.delta,
           label=excluded.label, computed_at=excluded.computed_at;`.replace(/\s+/g, " "),
      );
    }
  }
  console.log(`  usage_trends rows: ${trendSql.length}`);
  loadRows(trendSql, { database: db, remote, label: "usage_trends", batchSize: 300 });

  loadRows(
    [
      `INSERT INTO ingest_runs (job, started_at, finished_at, status, row_count) VALUES ('materialize', ${sql(now)}, ${sql(new Date().toISOString())}, 'ok', ${dvpSql.length + trendSql.length});`,
    ],
    { database: db, remote, label: "ingest_runs" },
  );
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

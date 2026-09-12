import type { Position } from "../../domain/types";

/**
 * Read-side queries for the request path. Every one of these is a narrow, indexed lookup
 * over pre-materialized rows: the free plan allows 10 ms of CPU per request, so nothing
 * here aggregates (DECISIONS D13).
 */

export interface ProjectionRow {
  player_id: string;
  source: string;
  points: number;
  floor: number | null;
  ceiling: number | null;
  opponent: string | null;
  as_of: string;
}

export interface DvpLookup {
  team: string;
  position: string;
  fpa_per_game: number;
  rank: number;
  prior_weight: number;
}

export interface GameRow {
  id: string;
  week: number;
  home: string;
  away: string;
  kickoff: string | null;
  roof: string | null;
  spread: number | null;
  total: number | null;
  implied_home: number | null;
  implied_away: number | null;
  temp_f: number | null;
  wind_mph: number | null;
  precip_prob: number | null;
}

export interface DepthRow {
  player_id: string;
  team: string;
  pos_abb: string;
  pos_rank: number;
  name: string;
  injury_status: string | null;
}

const CHUNK = 90;

function chunks<T>(xs: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export class AnalyticsRepo {
  constructor(private readonly db: D1Database) {}

  async projections(
    playerIds: readonly string[],
    season: number,
    week: number,
  ): Promise<Map<string, ProjectionRow[]>> {
    const out = new Map<string, ProjectionRow[]>();
    if (playerIds.length === 0) return out;

    for (const chunk of chunks(playerIds)) {
      const marks = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(
          `SELECT player_id, source, points, floor, ceiling, opponent, as_of
           FROM projections
           WHERE season = ? AND week = ? AND player_id IN (${marks})`,
        )
        .bind(season, String(week), ...chunk)
        .all<ProjectionRow>();
      for (const r of res.results) {
        const list = out.get(r.player_id) ?? [];
        list.push(r);
        out.set(r.player_id, list);
      }
    }
    return out;
  }

  /** Whole-slate DvP for one week; 256 small rows, cheaper than per-player lookups. */
  async defenseVsPosition(season: number, throughWeek: number): Promise<DvpLookup[]> {
    const res = await this.db
      .prepare(
        `SELECT team, position, fpa_per_game, rank, prior_weight
         FROM defense_vs_position
         WHERE season = ? AND through_week = (
           SELECT MAX(through_week) FROM defense_vs_position
           WHERE season = ? AND through_week <= ?
         )`,
      )
      .bind(season, season, throughWeek)
      .all<DvpLookup>();
    return res.results;
  }

  async games(season: number, week: number): Promise<GameRow[]> {
    const res = await this.db
      .prepare(
        `SELECT id, week, home, away, kickoff, roof, spread, total, implied_home,
                implied_away, temp_f, wind_mph, precip_prob
         FROM games WHERE season = ? AND week = ?`,
      )
      .bind(season, week)
      .all<GameRow>();
    return res.results;
  }

  /** Recent scored weeks per player, newest last, for range and trend context. */
  async recentPoints(
    playerIds: readonly string[],
    season: number,
    beforeWeek: number,
    priorSeason: number,
  ): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    if (playerIds.length === 0) return out;

    for (const chunk of chunks(playerIds)) {
      const marks = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(
          `SELECT player_id, season, week, stat_line FROM player_week_stats
           WHERE player_id IN (${marks})
             AND ((season = ? AND week < ?) OR season = ?)
           ORDER BY season, week`,
        )
        .bind(...chunk, season, beforeWeek, priorSeason)
        .all<{ player_id: string; stat_line: string }>();

      for (const r of res.results) {
        let pts = 0;
        try {
          pts = (JSON.parse(r.stat_line) as { __pts?: number }).__pts ?? 0;
        } catch {
          continue;
        }
        const list = out.get(r.player_id) ?? [];
        list.push(pts);
        out.set(r.player_id, list);
      }
    }
    return out;
  }

  /**
   * Depth-chart context for a set of players: where each sits at their spot, and who else
   * is listed there with what injury designation.
   *
   * Two steps rather than pulling the whole chart. Fetching every entry for a season is
   * nine thousand rows; this asks which spots the players actually occupy, then only the
   * teammates at those spots.
   */
  async depthContext(
    playerIds: readonly string[],
    season: number,
  ): Promise<{ mine: DepthRow[]; sameSpot: DepthRow[] }> {
    if (playerIds.length === 0) return { mine: [], sameSpot: [] };

    const mine: DepthRow[] = [];
    for (const chunk of chunks(playerIds)) {
      const marks = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(
          `SELECT d.player_id, d.team, d.pos_abb, d.pos_rank, p.name, p.injury_status
           FROM depth_charts d JOIN players p ON p.canonical_id = d.player_id
           WHERE d.season = ? AND d.player_id IN (${marks})`,
        )
        .bind(season, ...chunk)
        .all<DepthRow>();
      mine.push(...res.results);
    }
    if (mine.length === 0) return { mine: [], sameSpot: [] };

    const teams = [...new Set(mine.map((r) => r.team))];
    const spots = [...new Set(mine.map((r) => r.pos_abb))];
    const sameSpot: DepthRow[] = [];
    for (const teamChunk of chunks(teams, 40)) {
      const tMarks = teamChunk.map(() => "?").join(",");
      const sMarks = spots.map(() => "?").join(",");
      const res = await this.db
        .prepare(
          `SELECT d.player_id, d.team, d.pos_abb, d.pos_rank, p.name, p.injury_status
           FROM depth_charts d JOIN players p ON p.canonical_id = d.player_id
           WHERE d.season = ? AND d.team IN (${tMarks}) AND d.pos_abb IN (${sMarks})`,
        )
        .bind(season, ...teamChunk, ...spots)
        .all<DepthRow>();
      sameSpot.push(...res.results);
    }
    return { mine, sameSpot };
  }

  async usageTrends(
    playerIds: readonly string[],
    season: number,
    throughWeek: number,
  ): Promise<Map<string, { metric: string; label: string; delta: number }[]>> {
    const out = new Map<string, { metric: string; label: string; delta: number }[]>();
    if (playerIds.length === 0) return out;

    for (const chunk of chunks(playerIds)) {
      const marks = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(
          `SELECT player_id, metric, label, delta FROM usage_trends
           WHERE season = ? AND through_week <= ? AND player_id IN (${marks})`,
        )
        .bind(season, throughWeek, ...chunk)
        .all<{ player_id: string; metric: string; label: string; delta: number }>();
      for (const r of res.results) {
        const list = out.get(r.player_id) ?? [];
        list.push({ metric: r.metric, label: r.label, delta: r.delta });
        out.set(r.player_id, list);
      }
    }
    return out;
  }
}

/** Index DvP rows for O(1) lookup by team and position. */
export function indexDvp(rows: readonly DvpLookup[]): {
  get(team: string | null, position: Position): DvpLookup | null;
  distribution(position: Position): { mean: number; sigma: number };
} {
  const byKey = new Map<string, DvpLookup>();
  const byPosition = new Map<string, number[]>();
  for (const r of rows) {
    byKey.set(`${r.team}|${r.position}`, r);
    const list = byPosition.get(r.position) ?? [];
    list.push(r.fpa_per_game);
    byPosition.set(r.position, list);
  }

  const stats = new Map<string, { mean: number; sigma: number }>();
  for (const [position, values] of byPosition) {
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const sigma = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length);
    stats.set(position, { mean: m, sigma });
  }

  return {
    get: (team, position) => (team ? (byKey.get(`${team}|${position}`) ?? null) : null),
    distribution: (position) => stats.get(position) ?? { mean: 0, sigma: 0 },
  };
}

/** Index games so a team maps to its opponent and environment for the week. */
export function indexGames(
  rows: readonly GameRow[],
): Map<string, { opponent: string; isHome: boolean; game: GameRow; impliedTotal: number | null }> {
  const out = new Map<
    string,
    { opponent: string; isHome: boolean; game: GameRow; impliedTotal: number | null }
  >();
  for (const g of rows) {
    out.set(g.home, {
      opponent: g.away,
      isHome: true,
      game: g,
      impliedTotal: g.implied_home,
    });
    out.set(g.away, {
      opponent: g.home,
      isHome: false,
      game: g,
      impliedTotal: g.implied_away,
    });
  }
  return out;
}

import type { InjuryStatus, Player, PlayerStatus, Position } from "../../domain/types";

export interface PlayerRow {
  canonical_id: string;
  sleeper_id: string | null;
  gsis_id: string | null;
  name: string;
  search_name: string;
  position: string;
  fantasy_positions: string;
  team: string | null;
  status: string;
  injury_status: string | null;
  injury_body_part: string | null;
  injury_note: string | null;
  injury_updated_at: string | null;
  bye_week: number | null;
  depth_chart_order: number | null;
  age: number | null;
  years_exp: number | null;
  updated_at: string;
  fetched_at: string;
}

const SELECT = `SELECT canonical_id, sleeper_id, gsis_id, name, search_name, position,
  fantasy_positions, team, status, injury_status, injury_body_part, injury_note,
  injury_updated_at, bye_week, depth_chart_order, age, years_exp, updated_at, fetched_at
  FROM players`;

export function rowToPlayer(r: PlayerRow): Player & { fantasyPositions: Position[] } {
  return {
    canonicalId: r.canonical_id,
    externalIds: {
      ...(r.sleeper_id ? { sleeper: r.sleeper_id } : {}),
      ...(r.gsis_id ? { gsis: r.gsis_id } : {}),
    },
    name: r.name,
    position: r.position as Position,
    fantasyPositions: JSON.parse(r.fantasy_positions) as Position[],
    team: r.team,
    status: r.status as PlayerStatus,
    injury: {
      status: (r.injury_status ?? "healthy") as InjuryStatus,
      ...(r.injury_body_part ? { bodyPart: r.injury_body_part } : {}),
      ...(r.injury_note ? { note: r.injury_note } : {}),
      ...(r.injury_updated_at ? { updatedAt: r.injury_updated_at } : {}),
    },
    byeWeek: r.bye_week,
    ...(r.depth_chart_order !== null ? { depthChartOrder: r.depth_chart_order } : {}),
    ...(r.age !== null ? { age: r.age } : {}),
    ...(r.years_exp !== null ? { yearsExp: r.years_exp } : {}),
    updatedAt: r.updated_at,
  };
}

export class PlayerRepo {
  constructor(private readonly db: D1Database) {}

  async byCanonicalIds(ids: readonly string[]): Promise<Map<string, PlayerRow>> {
    if (ids.length === 0) return new Map();
    // D1 has a bound-parameter ceiling; chunk rather than risk a silent truncation.
    const out = new Map<string, PlayerRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const marks = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(`${SELECT} WHERE canonical_id IN (${marks})`)
        .bind(...chunk)
        .all<PlayerRow>();
      for (const r of res.results) out.set(r.canonical_id, r);
    }
    return out;
  }

  async bySleeperIds(ids: readonly string[]): Promise<Map<string, PlayerRow>> {
    if (ids.length === 0) return new Map();
    const out = new Map<string, PlayerRow>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const marks = chunk.map(() => "?").join(",");
      const res = await this.db
        .prepare(`${SELECT} WHERE sleeper_id IN (${marks})`)
        .bind(...chunk)
        .all<PlayerRow>();
      for (const r of res.results) if (r.sleeper_id) out.set(r.sleeper_id, r);
    }
    return out;
  }

  /** Prefix and substring match on the normalized name, active players first. */
  async search(query: string, position: string | null, limit: number): Promise<PlayerRow[]> {
    const like = `%${query}%`;
    const sql = `${SELECT}
      WHERE search_name LIKE ?
        ${position ? "AND (position = ? OR fantasy_positions LIKE ?)" : ""}
      ORDER BY
        CASE WHEN search_name = ? THEN 0
             WHEN search_name LIKE ? THEN 1
             ELSE 2 END,
        CASE WHEN status = 'active' AND team IS NOT NULL THEN 0 ELSE 1 END,
        COALESCE(depth_chart_order, 99),
        name
      LIMIT ?`;
    const params: (string | number)[] = [like];
    if (position) params.push(position, `%"${position}"%`);
    params.push(query, `${query}%`, limit);
    const res = await this.db
      .prepare(sql)
      .bind(...params)
      .all<PlayerRow>();
    return res.results;
  }

  async count(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>();
    return r?.n ?? 0;
  }

  async freshness(): Promise<string | null> {
    const r = await this.db
      .prepare("SELECT MAX(fetched_at) AS t FROM players")
      .first<{ t: string | null }>();
    return r?.t ?? null;
  }
}

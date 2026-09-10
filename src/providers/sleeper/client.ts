// Sleeper public read-only API. No auth. SPEC section 5.
// TTLs: league/rosters/matchups 5 min, trending 1 h, players/nfl once daily.

import { z } from "zod";
import { getJson } from "../http";
import type { Provider, ProviderHealth } from "../types";
import {
  leagueSchema,
  leagueUserSchema,
  matchupSchema,
  nflStateSchema,
  projectionRowSchema,
  rosterSchema,
  type SleeperLeague,
  type SleeperLeagueUser,
  type SleeperMatchup,
  type SleeperNflState,
  type SleeperProjectionRow,
  type SleeperRoster,
  trendingPlayerSchema,
  userSchema,
} from "./schemas";

const BASE = "https://api.sleeper.app/v1";
/** Projections live off the unversioned host (DECISIONS.md D6). */
const PROJ_BASE = "https://api.sleeper.app/projections/nfl";

const TTL = {
  state: 300,
  league: 300,
  rosters: 300,
  matchups: 300,
  trending: 3600,
  projections: 3600,
} as const;

export class SleeperProvider implements Provider {
  readonly name = "sleeper";

  constructor(private readonly now: () => Date) {}

  private get<T>(path: string, schema: z.ZodType<T>, ttl: number): Promise<T> {
    return getJson<unknown>(
      { provider: this.name, url: `${BASE}${path}`, cacheTtlSec: ttl },
      this.now(),
    ).then((raw) => schema.parse(raw));
  }

  async health(): Promise<ProviderHealth> {
    try {
      const state = await this.getNflState();
      return {
        name: this.name,
        ok: true,
        asOf: this.now().toISOString(),
        note: `week ${state.week}`,
      };
    } catch (err) {
      return {
        name: this.name,
        ok: false,
        asOf: this.now().toISOString(),
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getNflState(): Promise<SleeperNflState> {
    return this.get("/state/nfl", nflStateSchema, TTL.state);
  }

  getUser(username: string): Promise<z.infer<typeof userSchema>> {
    return this.get(`/user/${encodeURIComponent(username)}`, userSchema, 3600);
  }

  getUserLeagues(userId: string, season: number): Promise<SleeperLeague[]> {
    return this.get(`/user/${userId}/leagues/nfl/${season}`, z.array(leagueSchema), TTL.league);
  }

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.get(`/league/${leagueId}`, leagueSchema, TTL.league);
  }

  getRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.get(`/league/${leagueId}/rosters`, z.array(rosterSchema), TTL.rosters);
  }

  getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]> {
    return this.get(`/league/${leagueId}/users`, z.array(leagueUserSchema), TTL.league);
  }

  getMatchups(leagueId: string, week: number): Promise<SleeperMatchup[]> {
    return this.get(`/league/${leagueId}/matchups/${week}`, z.array(matchupSchema), TTL.matchups);
  }

  getTrendingAdds(limit = 25): Promise<{ player_id: string; count: number }[]> {
    return this.get(
      `/players/nfl/trending/add?limit=${limit}`,
      z.array(trendingPlayerSchema),
      TTL.trending,
    );
  }

  /** One position at a time; the full-slate response is several MB. */
  async getProjections(
    season: number,
    week: number,
    position: string,
  ): Promise<SleeperProjectionRow[]> {
    const url = `${PROJ_BASE}/${season}/${week}?season_type=regular&position[]=${position}&order_by=ppr`;
    const raw = await getJson<unknown>(
      { provider: this.name, url, cacheTtlSec: TTL.projections },
      this.now(),
    );
    return z.array(projectionRowSchema).parse(raw);
  }
}

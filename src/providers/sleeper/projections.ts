import { z } from "zod";
import { getJson } from "../http";
import type { Provider, ProviderHealth } from "../types";
import { projectionRowSchema, type SleeperProjectionRow } from "./schemas";

/**
 * Sleeper's projections endpoint.
 *
 * This is undocumented and unsupported: it lives on the unversioned host rather than
 * under /v1, and Sleeper makes no promise about it. It is kept in its own file, behind
 * the same shape as any other projection source, so that if it disappears the only thing
 * that changes is which provider returns rows. The engine then falls back to trailing
 * averages, lowers confidence and says so in `caveats` (DECISIONS D6).
 *
 * Its `stats` field is the value here. The accompanying `pts_ppr` is scored for
 * Sleeper's own preset formats and is meaningless for IDP, so callers must recompute
 * points from the stat line against the league's scoring map (DECISIONS D5).
 */

const BASE = "https://api.sleeper.app/projections/nfl";

/** The endpoint keys on fantasy buckets, not raw NFL positions: DE and CB return zero rows. */
export const PROJECTION_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"] as const;

export class SleeperProjectionsProvider implements Provider {
  readonly name = "sleeper-projections";

  constructor(private readonly now: () => Date) {}

  async health(): Promise<ProviderHealth> {
    const asOf = this.now().toISOString();
    try {
      const state = await getJson<{ season: string; week: number }>(
        { provider: this.name, url: "https://api.sleeper.app/v1/state/nfl", cacheTtlSec: 300 },
        this.now(),
      );
      const rows = await this.forPosition(Number(state.season), state.week, "QB");
      const withStats = rows.filter((r) => r.stats && Object.keys(r.stats).length > 2);
      return {
        name: this.name,
        ok: withStats.length > 0,
        asOf,
        note: `${withStats.length} projected quarterbacks`,
      };
    } catch (err) {
      return {
        name: this.name,
        ok: false,
        asOf,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** One position per call; the full slate is several megabytes. */
  async forPosition(
    season: number,
    week: number,
    position: string,
  ): Promise<SleeperProjectionRow[]> {
    const url = `${BASE}/${season}/${week}?season_type=regular&position[]=${position}&order_by=ppr`;
    const raw = await getJson<unknown>({ provider: this.name, url, cacheTtlSec: 3600 }, this.now());
    return z.array(projectionRowSchema).parse(raw);
  }
}

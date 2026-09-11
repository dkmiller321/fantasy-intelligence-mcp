import { z } from "zod";
import type { Provider, ProviderHealth } from "../types";

/**
 * FantasyPros partner API.
 *
 * Unlike Sleeper's and ESPN's projection endpoints this one is documented and supported,
 * and it is the only second source that covers individual defensive players. It needs an
 * approved key, so every call site treats it as optional: without `FANTASYPROS_KEY` the
 * provider is simply absent and the engine blends whatever else exists.
 *
 * Two limits of this key's tier, both measured rather than assumed:
 *
 * - **Ten players per response.** Neither `limit`, `max`, `count`, nor a multi-position
 *   `positions=` filter widens it, and `/nfl/players` is capped the same way, so the full
 *   roster cannot be enumerated from the API. Specific players can be requested by
 *   FantasyPros id, which is how this adapter gets useful coverage: ids come from the
 *   dynastyprocess crosswalk and are requested in batches of ten.
 * - **A request quota.** The spec describes this as "the free limited public API". The
 *   quota is not documented and is not returned in any header; exceeding it gives
 *   `429 {"message":"Limit Exceeded"}` that persists for far longer than a throttle, so
 *   it is a budget rather than a rate. Roughly forty exploratory calls exhausted a day.
 *
 * The adapter is therefore deliberately frugal: a full refresh costs about thirteen
 * requests, and hitting the quota stops the run cleanly with whatever was already
 * collected rather than failing the sync.
 */

const BASE = "https://api.fantasypros.com/public/v2/json/nfl";

/** Spacing between calls; below roughly two seconds the API starts returning 403. */
const THROTTLE_MS = 2500;
/** The tier's page size. Requesting more ids per call simply truncates. */
export const BATCH_SIZE = 10;

const playerSchema = z.object({
  fpid: z.number(),
  name: z.string(),
  position_id: z.string(),
  team_id: z.string().nullable().optional(),
  stats: z.record(z.string(), z.number()),
});

const responseSchema = z.object({
  players: z.array(playerSchema).nullable().optional(),
});

export interface FantasyProsProjection {
  fpid: string;
  name: string;
  positionId: string;
  team: string | null;
  stats: Record<string, number>;
}

/** Raised when the daily quota is gone, so callers can keep partial results. */
export class QuotaExhausted extends Error {
  constructor() {
    super("fantasypros: request quota exhausted (HTTP 429)");
    this.name = "QuotaExhausted";
  }
}

export class FantasyProsProvider implements Provider {
  readonly name = "fantasypros";
  /** Requests made by this instance, so a caller can report and cap the cost. */
  requestsMade = 0;

  constructor(
    private readonly apiKey: string,
    private readonly now: () => Date,
  ) {}

  /** True when a key is configured; callers skip the provider entirely otherwise. */
  static isConfigured(key: string | undefined): key is string {
    return typeof key === "string" && key.trim().length > 0;
  }

  async health(): Promise<ProviderHealth> {
    const asOf = this.now().toISOString();
    try {
      const rows = await this.request("/2026/projections?position=RB&week=1");
      return { name: this.name, ok: rows.length > 0, asOf, note: `${rows.length} players` };
    } catch (err) {
      return {
        name: this.name,
        ok: false,
        asOf,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async request(path: string): Promise<FantasyProsProjection[]> {
    this.requestsMade++;
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-api-key": this.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    // 429 is the quota, not a throttle: retrying inside the run only wastes more of it.
    if (res.status === 429) throw new QuotaExhausted();
    if (!res.ok) throw new Error(`fantasypros: HTTP ${res.status}`);

    const parsed = responseSchema.parse(await res.json());
    return (parsed.players ?? []).map((p) => ({
      fpid: String(p.fpid),
      name: p.name,
      positionId: p.position_id,
      team: p.team_id ?? null,
      stats: p.stats,
    }));
  }

  /** The top ten projected players at a position, which is all this tier returns. */
  async topByPosition(
    season: number,
    week: number,
    position: string,
  ): Promise<FantasyProsProjection[]> {
    return this.request(`/${season}/projections?position=${position}&week=${week}`);
  }

  /**
   * Projections for specific players, batched and throttled. This is how coverage is
   * obtained beyond the top ten: ask for exactly the players that matter.
   *
   * Stops and returns what it has when the quota runs out. A partial second source still
   * lifts confidence for the players it covered, and the caller reports how many.
   */
  async forPlayers(
    season: number,
    week: number,
    fpids: readonly string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ projections: FantasyProsProjection[]; quotaExhausted: boolean }> {
    const out: FantasyProsProjection[] = [];
    const unique = [...new Set(fpids)];

    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      if (i > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS));

      try {
        out.push(
          ...(await this.request(`/${season}/projections?players=${batch.join(":")}&week=${week}`)),
        );
      } catch (err) {
        if (err instanceof QuotaExhausted) return { projections: out, quotaExhausted: true };
        // A single rejected batch must not lose the rest.
        const reason = err instanceof Error ? err.message : String(err);
        if (!reason.includes("403")) throw err;
        await new Promise((r) => setTimeout(r, THROTTLE_MS * 2));
      }
      onProgress?.(Math.min(i + BATCH_SIZE, unique.length), unique.length);
    }

    return { projections: out, quotaExhausted: false };
  }

  /**
   * The top ten at every position this league starts, which is eight requests and the
   * cheapest useful coverage the tier allows.
   */
  async topAcrossPositions(
    season: number,
    week: number,
    positions: readonly string[],
  ): Promise<{ projections: FantasyProsProjection[]; quotaExhausted: boolean }> {
    const out: FantasyProsProjection[] = [];
    for (const [i, position] of positions.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS));
      try {
        out.push(...(await this.topByPosition(season, week, position)));
      } catch (err) {
        if (err instanceof QuotaExhausted) return { projections: out, quotaExhausted: true };
        throw err;
      }
    }
    return { projections: out, quotaExhausted: false };
  }
}

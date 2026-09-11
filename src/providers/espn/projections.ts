import { z } from "zod";
import type { Provider, ProviderHealth } from "../types";

/**
 * ESPN fantasy projections.
 *
 * Keyless, but undocumented and unsupported in the same way Sleeper's projections
 * endpoint is: a public read API the fantasy community relies on, with no contract behind
 * it. It is isolated here so that its disappearance costs one source rather than breaking
 * the engine, which already blends however many sources exist.
 *
 * It reads from ESPN's public default league (`leaguedefaults/3`), never from a private
 * league, so no credential is involved and no private data is touched.
 *
 * It does not cover IDP: a request filtered to defensive slots returns HTTP 400, because
 * the default league has no such slots. Seven of this league's eighteen starting slots
 * therefore remain single-source.
 */

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

const statEntrySchema = z.object({
  seasonId: z.number(),
  scoringPeriodId: z.number(),
  /** 0 = actual, 1 = projected. */
  statSourceId: z.number(),
  /** 1 = a single week. */
  statSplitTypeId: z.number(),
  appliedTotal: z.number().nullable().optional(),
  stats: z.record(z.string(), z.number()),
});

const playerSchema = z.object({
  player: z.object({
    id: z.number(),
    fullName: z.string(),
    defaultPositionId: z.number(),
    proTeamId: z.number().optional(),
    stats: z.array(statEntrySchema).nullable().optional(),
  }),
});

const responseSchema = z.object({
  players: z.array(playerSchema).nullable().optional(),
});

export interface EspnProjection {
  espnId: string;
  name: string;
  positionId: number;
  stats: Record<string, number>;
}

export class EspnProjectionsProvider implements Provider {
  readonly name = "espn";

  constructor(private readonly now: () => Date) {}

  async health(): Promise<ProviderHealth> {
    const asOf = this.now().toISOString();
    try {
      const rows = await this.forWeek(this.now().getUTCFullYear(), 1, 5);
      return { name: this.name, ok: rows.length > 0, asOf, note: `${rows.length} projections` };
    } catch (err) {
      return {
        name: this.name,
        ok: false,
        asOf,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Projections for one week. ESPN returns a player's whole stat history in one payload,
   * so the caller asks for a page of players and the week is selected from what comes
   * back rather than by a server-side filter.
   */
  async forWeek(season: number, week: number, limit = 400): Promise<EspnProjection[]> {
    const url = `${BASE}/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
    const filter = {
      players: {
        limit,
        sortPercOwned: { sortAsc: false, sortPriority: 1 },
      },
    };

    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-fantasy-filter": JSON.stringify(filter),
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`espn: HTTP ${res.status}`);

    const parsed = responseSchema.parse(await res.json());
    const out: EspnProjection[] = [];

    for (const entry of parsed.players ?? []) {
      const p = entry.player;
      const projection = (p.stats ?? []).find(
        (s) =>
          s.seasonId === season &&
          s.scoringPeriodId === week &&
          s.statSourceId === 1 &&
          s.statSplitTypeId === 1,
      );
      if (!projection) continue;
      out.push({
        espnId: String(p.id),
        name: p.fullName,
        positionId: p.defaultPositionId,
        stats: projection.stats,
      });
    }

    return out;
  }
}

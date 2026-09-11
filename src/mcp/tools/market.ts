import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { roundPoints } from "../../domain/envelope";
import type { NewsImpact, Position } from "../../domain/types";
import { optimizeLineup } from "../../engine/lineup";
import { canFill } from "../../engine/slots";
import { evaluateTrade, scoreWaiver, type TradeAsset, valueAsset } from "../../engine/trade";
import { syncLeague } from "../../jobs/sync-league";
import { NewsRepo } from "../../storage/d1/news";
import type { PlayerRow } from "../../storage/d1/players";
import { resolveLeagueId, resolveSeasonWeek, sleeperUserId, type ToolContext } from "../context";
import { degraded, envelope, toolResult } from "../envelope";
import { type EvaluatedPlayer, evaluatePlayers, evaluationCaveats } from "../evaluate";
import { safeHandler } from "../safe";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB"] as const;

/**
 * Points per game a freely available player at each position provides.
 *
 * A missing position must not fall through to zero: that would price every player at
 * that position as if a roster spot were worth nothing, inflating their trade value
 * several-fold. In a deep dynasty league it is common for a position to have no
 * meaningful free agents at all, so an explicit floor is used and reported.
 */
function replacementLevels(pool: readonly EvaluatedPlayer[]): Map<Position, number> {
  const byPos = new Map<Position, number[]>();
  for (const p of pool) {
    if (p.points === null) continue;
    const list = byPos.get(p.position) ?? [];
    list.push(p.points);
    byPos.set(p.position, list);
  }
  const out = new Map<Position, number>();
  for (const [pos, values] of byPos) {
    values.sort((a, b) => b - a);
    out.set(pos, values[0] ?? 0);
  }
  return out;
}

/** Fallback replacement level when the wire is bare at a position. */
const REPLACEMENT_FLOOR: Record<string, number> = {
  QB: 14,
  RB: 6,
  WR: 6,
  TE: 5,
  K: 6,
  DEF: 5,
  DL: 4,
  LB: 5,
  DB: 4,
};

/**
 * Depth-chart rank as an opportunity score. A published starter is the strong signal; the
 * immediate backup still matters because one injury promotes them. Beyond that the rank
 * says little a projection does not already capture.
 */
function opportunityFor(publishedRank: number | null, sleeperOrder: number | null): number {
  if (publishedRank !== null) {
    if (publishedRank === 1) return 1;
    if (publishedRank === 2) return 0.5;
    return 0.15;
  }
  // No published entry: fall back to Sleeper's ordering, which is coarser.
  return sleeperOrder === 1 ? 0.6 : 0.2;
}

function ordinal(n: number): string {
  const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

export function registerMarketTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_news",
    {
      description:
        "Recent NFL headlines, newest first, matched to players. Pass `since` (an ISO " +
        "timestamp) to get only what has changed since then, which is how to answer 'what " +
        "happened today' or 'anything new on my roster'. Filter with minImpact to skip noise. " +
        "Injury designations from Sleeper are authoritative; these headlines add the context.",
      inputSchema: {
        leagueId: z.string().optional().describe("Restrict to players on the owner's roster"),
        playerIds: z.array(z.string()).max(20).optional(),
        since: z.string().optional().describe("ISO timestamp"),
        minImpact: z.enum(["high", "medium", "low"]).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler(
      "get_news",
      ctx.now,
      async ({ leagueId: explicit, playerIds, since, minImpact, limit }) => {
        const now = ctx.now();
        const { season, week } = await resolveSeasonWeek(ctx);
        const repo = new NewsRepo(ctx.env.DB);

        let ids = playerIds ?? [];
        const leagueId = await resolveLeagueId(ctx, explicit);
        if (ids.length === 0 && explicit !== undefined && leagueId) {
          // Roster-scoped: only news about players the owner actually holds.
          const userId = await sleeperUserId(ctx);
          const { myTeam } = await syncLeague(ctx.sleeper, ctx.env.DB, leagueId, userId, now);
          if (myTeam) {
            const rows = await ctx.players.bySleeperIds(myTeam.playerIds);
            ids = [...rows.values()].map((r) => r.canonical_id);
          }
        }

        const items = await repo.recent({
          ...(since ? { since } : {}),
          ...(minImpact ? { minImpact: minImpact as NewsImpact } : {}),
          ...(ids.length > 0 ? { playerIds: ids } : {}),
          limit: limit ?? 20,
        });

        const named = await ctx.players.byCanonicalIds([
          ...new Set(items.flatMap((i) => i.playerIds)),
        ]);
        const rows = items.map((i) => ({
          title: i.title,
          source: i.source,
          impact: i.impact,
          publishedAt: i.publishedAt,
          url: i.url ?? null,
          players: i.playerIds.map((id) => named.get(id)?.name ?? id),
        }));

        const caveats: string[] = [];
        const freshness = await repo.freshness();
        if (!freshness) {
          caveats.push("No news has been ingested yet; the RSS job may not have run.");
        }
        if (rows.length === 0 && since) {
          caveats.push(`Nothing published since ${since}.`);
        }
        const unmatched = items.filter((i) => i.playerIds.length === 0).length;
        if (unmatched > 0) {
          caveats.push(
            `${unmatched} headlines could not be tied to a specific player, usually because a ` +
              "surname is shared. They are included rather than dropped.",
          );
        }

        const high = rows.filter((r) => r.impact === "high").length;
        return toolResult(
          envelope({
            summary:
              rows.length === 0
                ? "No matching news."
                : `${rows.length} items${high > 0 ? `, ${high} high impact` : ""}` +
                  `${since ? ` since ${since}` : ""}.`,
            data: { items: rows },
            season,
            week,
            now,
            ...(leagueId ? { leagueId } : {}),
            caveats,
            sources: [{ name: "rss", asOf: freshness ?? now.toISOString() }],
          }),
        );
      },
    ),
  );

  server.registerTool(
    "get_waiver_targets",
    {
      description:
        "Free agents worth adding, ranked, with why they matter now and a suggested FAAB bid " +
        "as a percentage of the season budget. Excludes everyone already rostered in the " +
        "league. Use for 'who should I pick up' or waiver-wire questions.",
      inputSchema: {
        leagueId: z.string().optional(),
        position: z.enum(POSITIONS).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_waiver_targets", ctx.now, async ({ leagueId: explicit, position, limit }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx);
      const leagueId = await resolveLeagueId(ctx, explicit);
      if (!leagueId) {
        return degraded({
          data: null,
          season,
          week,
          now,
          failure: "No league id and no default set.",
        });
      }

      const userId = await sleeperUserId(ctx);
      const { league, teams, myTeam } = await syncLeague(
        ctx.sleeper,
        ctx.env.DB,
        leagueId,
        userId,
        now,
      );

      // Everyone rostered anywhere in the league is unavailable.
      const rostered = new Set(teams.flatMap((t) => [...t.playerIds, ...t.taxi, ...t.reserve]));

      const trending = await ctx.sleeper.getTrendingAdds(50).catch(() => []);
      const trendingBySleeper = new Map(trending.map((t) => [t.player_id, t.count]));
      const maxAdds = trending.reduce((a, t) => Math.max(a, t.count), 0);

      // Candidates: players with a projection this week who are not rostered.
      // Grouped by player: with two projection sources the join yields a row per source,
      // which previously put the same free agent in the list twice.
      const projected = await ctx.env.DB.prepare(
        `SELECT p.canonical_id, p.sleeper_id, p.gsis_id, p.name, p.search_name, p.position,
                p.fantasy_positions, p.team, p.status, p.injury_status, p.injury_body_part,
                p.injury_note, p.injury_updated_at, p.bye_week, p.depth_chart_order, p.age,
                p.years_exp, p.updated_at, p.fetched_at, AVG(j.points) AS avg_points
         FROM projections j JOIN players p ON p.canonical_id = j.player_id
         WHERE j.season = ? AND j.week = ? AND p.status = 'active' AND p.team IS NOT NULL
         ${position ? "AND p.position = ?" : ""}
         GROUP BY p.canonical_id
         ORDER BY avg_points DESC LIMIT 300`,
      )
        .bind(...(position ? [season, String(week), position] : [season, String(week)]))
        .all<PlayerRow>();

      const available = projected.results.filter(
        (r) => !r.sleeper_id || !rostered.has(r.sleeper_id),
      );
      if (available.length === 0) {
        return degraded({
          data: { targets: [] },
          season,
          week,
          now,
          leagueId,
          failure:
            "No projected free agents found. Projections may not be loaded for this week yet.",
        });
      }

      const result = await evaluatePlayers(ctx.env.DB, available.slice(0, 120), season, week);

      // Real depth-chart rank, published by the teams, rather than Sleeper's
      // depth_chart_order proxy (DECISIONS D21). Rank 1 at a position means the player
      // ahead of them is unavailable, which is the actual reason a free agent matters.
      const depthRank = new Map<string, { rank: number; posAbb: string }>();
      const candidateIds = result.players.map((p) => p.canonicalId).slice(0, 120);
      if (candidateIds.length > 0) {
        const marks = candidateIds.map(() => "?").join(",");
        const depth = await ctx.env.DB.prepare(
          `SELECT player_id, pos_abb, MIN(pos_rank) AS pos_rank FROM depth_charts
           WHERE season = ? AND player_id IN (${marks}) GROUP BY player_id`,
        )
          .bind(season, ...candidateIds)
          .all<{ player_id: string; pos_abb: string; pos_rank: number }>();
        for (const d of depth.results) {
          depthRank.set(d.player_id, { rank: d.pos_rank, posAbb: d.pos_abb });
        }
      }

      /**
       * Value is measured against the owner's own lineup, not against the whole player
       * pool. Ranking by raw projection returns six quarterbacks, because quarterbacks
       * score most, which is useless advice to someone who starts one and already
       * rosters four. What matters is whether an addition would actually start.
       */
      const myRows = myTeam
        ? [
            ...(
              await ctx.players.bySleeperIds(
                myTeam.playerIds.filter(
                  (id) => !myTeam.taxi.includes(id) && !myTeam.reserve.includes(id),
                ),
              )
            ).values(),
          ]
        : [];
      const mine = await evaluatePlayers(ctx.env.DB, myRows, season, week);
      const myLineup = optimizeLineup(
        league.rosterPositions,
        mine.players.map((p) => ({
          canonicalId: p.canonicalId,
          name: p.name,
          position: p.position,
          fantasyPositions: p.fantasyPositions,
          points: p.points,
          eligible: p.eligible,
        })),
      );

      /** The weakest starter a candidate could displace, given slot eligibility. */
      const displaceable = (fantasyPositions: readonly Position[]): number => {
        const beatable = myLineup.assignments
          .filter((a) => canFill(a.slot, fantasyPositions))
          .map((a) => a.player?.points ?? 0);
        return beatable.length > 0 ? Math.min(...beatable) : Number.POSITIVE_INFINITY;
      };

      const scored = result.players
        .filter((p) => p.points !== null && p.eligible)
        .map((p) => {
          const row = available.find((r) => r.canonical_id === p.canonicalId);
          const adds = row?.sleeper_id ? (trendingBySleeper.get(row.sleeper_id) ?? 0) : 0;
          const pointsTrend = p.trend.find((t) => t.metric === "points");
          const usage =
            pointsTrend?.label === "rising" ? 1 : pointsTrend?.label === "falling" ? -1 : 0;

          const floor = displaceable(p.fantasyPositions);
          const upgrade = Number.isFinite(floor) ? (p.points as number) - floor : 0;
          // A five-point weekly upgrade is about as good as the wire ever offers.
          const rosValue = Math.max(0, Math.min(1, upgrade / 5));

          const scoredItem = scoreWaiver(
            {
              canonicalId: p.canonicalId,
              name: p.name,
              position: p.position,
              rosValue,
              usageTrend: usage,
              opportunity: opportunityFor(
                depthRank.get(p.canonicalId)?.rank ?? null,
                row?.depth_chart_order ?? null,
              ),
              trendingAdds: adds,
            },
            maxAdds,
          );

          const why: string[] = [];
          if (upgrade > 0) {
            why.push(`${roundPoints(upgrade)} points better than your weakest eligible starter`);
          }
          if (adds > 0) why.push(`${adds} adds across Sleeper in the last day`);
          if (pointsTrend?.label === "rising") why.push("scoring trending up");
          const depth = depthRank.get(p.canonicalId);
          if (depth) {
            why.push(
              depth.rank === 1
                ? `starting at ${depth.posAbb} on the published depth chart`
                : `${ordinal(depth.rank)} at ${depth.posAbb}`,
            );
          } else if (row?.depth_chart_order === 1) {
            why.push("listed first on the depth chart");
          }
          if (p.matchupRank !== null && p.matchupRank <= 8) {
            why.push(`favourable matchup vs ${p.opponent}`);
          }

          return {
            canonicalId: p.canonicalId,
            name: p.name,
            position: p.position,
            team: p.team,
            opponent: p.opponent,
            projected: roundPoints(p.points as number),
            upgradeOverWeakestStarter: Number.isFinite(displaceable(p.fantasyPositions))
              ? roundPoints((p.points as number) - displaceable(p.fantasyPositions))
              : null,
            score: scoredItem.score,
            faabBid: `${scoredItem.faabLow}-${scoredItem.faabHigh}% of budget`,
            faabDollars: league.faabBudget
              ? `$${Math.round((league.faabBudget * scoredItem.faabLow) / 100)}-` +
                `$${Math.round((league.faabBudget * scoredItem.faabHigh) / 100)}`
              : null,
            whyNow: why.length > 0 ? why.join("; ") : "best available by projection",
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit ?? 10);

      const caveats = evaluationCaveats(result);
      caveats.push(
        `${myTeam?.faabRemaining ?? "unknown"} FAAB remaining of ${league.faabBudget ?? "?"}.`,
      );

      return toolResult(
        envelope({
          summary:
            scored.length === 0
              ? "No free agents stood out this week."
              : `Top target: ${scored[0]?.name} (${scored[0]?.position}), ` +
                `bid ${scored[0]?.faabDollars ?? scored[0]?.faabBid}.`,
          data: { targets: scored },
          season,
          week,
          now,
          leagueId,
          caveats,
          detail: "full",
          sources: [{ name: "sleeper", asOf: now.toISOString() }],
        }),
      );
    }),
  );

  server.registerTool(
    "evaluate_trade",
    {
      description:
        "Judge a proposed trade. Values every player by points over replacement across the " +
        "remaining season, weights the fantasy playoff weeks more heavily, and applies a " +
        "dynasty age adjustment. Returns a verdict and the value on each side. Rookie draft " +
        "picks are not valued and are reported as unpriced.",
      inputSchema: {
        give: z.array(z.string()).min(1).max(6).describe("canonicalIds the owner sends away"),
        receive: z.array(z.string()).min(1).max(6).describe("canonicalIds the owner gets back"),
        leagueId: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("evaluate_trade", ctx.now, async ({ give, receive, leagueId: explicit }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx);
      const leagueId = await resolveLeagueId(ctx, explicit);
      if (!leagueId) {
        return degraded({
          data: null,
          season,
          week,
          now,
          failure: "No league id and no default set.",
        });
      }

      const userId = await sleeperUserId(ctx);
      const { league, teams } = await syncLeague(ctx.sleeper, ctx.env.DB, leagueId, userId, now);

      const wanted = [...give, ...receive];
      const rowMap = await ctx.players.byCanonicalIds(wanted);
      const missing = wanted.filter((id) => !rowMap.has(id));
      if (missing.length === wanted.length) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: "None of the given ids matched a player. Use search_players first.",
        });
      }

      const rows = [...rowMap.values()];
      const result = await evaluatePlayers(ctx.env.DB, rows, season, week);
      const byId = new Map(result.players.map((p) => [p.canonicalId, p]));

      // Replacement level is the best free agent at each position in this league.
      const rostered = new Set(teams.flatMap((t) => [...t.playerIds, ...t.taxi, ...t.reserve]));
      // Ranked within each position, not globally: ordering the whole pool by points
      // returns almost nothing but quarterbacks, which left the replacement level for
      // every other position at zero and inflated their trade value several-fold.
      const faPool = await ctx.env.DB.prepare(
        `SELECT canonical_id, sleeper_id, gsis_id, name, search_name, position,
                fantasy_positions, team, status, injury_status, injury_body_part,
                injury_note, injury_updated_at, bye_week, depth_chart_order, age,
                years_exp, updated_at, fetched_at FROM (
           SELECT p.*, ROW_NUMBER() OVER (PARTITION BY p.position ORDER BY AVG(j.points) DESC) AS rn
           FROM projections j JOIN players p ON p.canonical_id = j.player_id
           WHERE j.season = ? AND j.week = ? AND p.status = 'active' AND p.team IS NOT NULL
           GROUP BY p.canonical_id
         ) WHERE rn <= 60`,
      )
        .bind(season, String(week))
        .all<PlayerRow>();

      const freeAgents = faPool.results.filter((r) => !r.sleeper_id || !rostered.has(r.sleeper_id));
      const faEval = await evaluatePlayers(ctx.env.DB, freeAgents, season, week);
      const replacement = replacementLevels(faEval.players);

      const remainingWeeks = Math.max(1, 18 - week + 1);
      const playoffWeeks = Math.max(0, 18 - league.playoffWeekStart + 1);

      const toAsset = (id: string): TradeAsset | null => {
        const p = byId.get(id);
        const row = rowMap.get(id);
        if (!p) return null;
        return {
          canonicalId: p.canonicalId,
          name: p.name,
          position: p.position,
          pointsPerGame: p.points ?? 0,
          age: row?.age ?? null,
          replacementPpg: replacement.get(p.position) ?? REPLACEMENT_FLOOR[p.position] ?? 4,
        };
      };

      const giveAssets = give
        .map(toAsset)
        .filter((a): a is TradeAsset => a !== null)
        .map((a) => valueAsset(a, remainingWeeks, playoffWeeks));
      const receiveAssets = receive
        .map(toAsset)
        .filter((a): a is TradeAsset => a !== null)
        .map((a) => valueAsset(a, remainingWeeks, playoffWeeks));

      const verdict = evaluateTrade(giveAssets, receiveAssets);

      const caveats = evaluationCaveats(result);
      if (missing.length > 0) {
        caveats.push(
          `${missing.length} of the ids given did not match a player and were left out of the ` +
            "valuation, so the verdict is incomplete.",
        );
      }
      if (!league.isDynasty) {
        caveats.push("Age adjustment applied, though this league is not marked dynasty.");
      } else {
        caveats.push(
          "Dynasty age curve applied. Rookie draft picks are not valued at all; if the deal " +
            "includes picks, judge those separately.",
        );
      }
      caveats.push(
        `Playoff weeks ${league.playoffWeekStart}-18 are weighted ` +
          `${((1.25 - 1) * 100).toFixed(0)}% above regular-season weeks.`,
      );

      const describe = (a: (typeof giveAssets)[number]) => ({
        name: a.name,
        position: a.position,
        age: a.age,
        pointsPerGame: roundPoints(a.pointsPerGame),
        overReplacement: roundPoints(a.valueOverReplacement),
        ageMultiplier: a.ageMultiplier,
        value: a.adjustedValue,
      });

      return toolResult(
        envelope({
          summary:
            `${verdict.verdict.replace(/^\w/, (c) => c.toUpperCase())}: ` +
            `${verdict.net >= 0 ? "+" : ""}${verdict.net} net value ` +
            `(${verdict.receive.total} in, ${verdict.give.total} out).`,
          data: {
            verdict: verdict.verdict,
            net: verdict.net,
            give: { total: verdict.give.total, players: giveAssets.map(describe) },
            receive: { total: verdict.receive.total, players: receiveAssets.map(describe) },
            rosterFit: verdict.rosterFitNote,
            remainingWeeks,
            playoffWeeks,
          },
          season,
          week,
          now,
          leagueId,
          confidence: 0.6,
          caveats,
          detail: "full",
          sources: [{ name: "sleeper", asOf: now.toISOString() }],
        }),
      );
    }),
  );
}

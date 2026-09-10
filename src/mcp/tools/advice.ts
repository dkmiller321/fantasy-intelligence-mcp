import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { roundPoints } from "../../domain/envelope";
import type { Evidence } from "../../domain/types";
import { type LineupCandidate, lineupDelta, optimizeLineup } from "../../engine/lineup";
import { syncLeague } from "../../jobs/sync-league";
import type { PlayerRow } from "../../storage/d1/players";
import { resolveLeagueId, resolveSeasonWeek, sleeperUserId, type ToolContext } from "../context";
import { degraded, envelope, toolResult } from "../envelope";
import {
  decisionConfidence,
  type EvaluatedPlayer,
  evaluatePlayers,
  evaluationCaveats,
} from "../evaluate";
import { safeHandler } from "../safe";

function brief(p: EvaluatedPlayer) {
  return {
    canonicalId: p.canonicalId,
    name: p.name,
    position: p.position,
    team: p.team,
    opponent: p.opponent ? `${p.isHome ? "vs" : "@"} ${p.opponent}` : null,
    projected: p.points === null ? null : roundPoints(p.points),
    floor: p.floor === null ? null : roundPoints(p.floor),
    ceiling: p.ceiling === null ? null : roundPoints(p.ceiling),
    matchupRank: p.matchupRank,
    impliedTeamTotal: p.impliedTeamTotal === null ? null : roundPoints(p.impliedTeamTotal),
    injury: p.injury === "healthy" ? null : p.injury,
    eligible: p.eligible,
    trend: p.trend.find((t) => t.metric === "points")?.label ?? null,
  };
}

async function loadRosterRows(
  ctx: ToolContext,
  leagueId: string,
  now: Date,
): Promise<{
  rows: PlayerRow[];
  rosterPositions: string[];
  starters: string[];
  teamName: string;
  bySleeper: Map<string, PlayerRow>;
} | null> {
  const userId = await sleeperUserId(ctx);
  const { league, myTeam } = await syncLeague(ctx.sleeper, ctx.env.DB, leagueId, userId, now);
  if (!myTeam) return null;

  const taxi = new Set(myTeam.taxi);
  const reserve = new Set(myTeam.reserve);
  const activeIds = myTeam.playerIds.filter((id) => !taxi.has(id) && !reserve.has(id));
  const bySleeper = await ctx.players.bySleeperIds(activeIds);

  return {
    rows: [...bySleeper.values()],
    rosterPositions: league.rosterPositions,
    starters: myTeam.starters,
    teamName: myTeam.displayName,
    bySleeper,
  };
}

export function registerAdviceTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "compare_players",
    {
      description:
        "Head-to-head comparison of two to four players for one week: projection, floor and " +
        "ceiling, opponent matchup grade, game environment, injury status and usage trend, " +
        "with a lean and a confidence score. This is the start/sit tool. Pass canonicalIds " +
        "from search_players. Prefer this over calling get_player_profile several times.",
      inputSchema: {
        playerIds: z.array(z.string()).min(2).max(4).describe("canonicalIds from search_players"),
        leagueId: z.string().optional(),
        week: z.number().int().min(1).max(18).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("compare_players", ctx.now, async ({ playerIds, leagueId: explicit, week: w }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx, w);
      const leagueId = await resolveLeagueId(ctx, explicit);

      const rowMap = await ctx.players.byCanonicalIds(playerIds);
      const rows = playerIds
        .map((id) => rowMap.get(id))
        .filter((r): r is PlayerRow => r !== undefined);

      if (rows.length < 2) {
        return degraded({
          data: null,
          season,
          week,
          now,
          ...(leagueId ? { leagueId } : {}),
          failure:
            `Only ${rows.length} of ${playerIds.length} ids resolved to a player. ` +
            "Use search_players to get canonicalIds.",
        });
      }

      const result = await evaluatePlayers(ctx.env.DB, rows, season, week);
      const ranked = [...result.players].sort((a, b) => (b.points ?? -1) - (a.points ?? -1));
      const leader = ranked[0] as EvaluatedPlayer;
      const runnerUp = ranked[1] ?? null;
      const conf = decisionConfidence(leader, runnerUp);

      const margin =
        leader.points !== null && runnerUp?.points != null
          ? roundPoints(leader.points - runnerUp.points)
          : null;

      const evidence: Evidence[] = leader.evidence.map((e) => ({
        ...e,
        factor: `${leader.name}: ${e.factor}`,
      }));
      if (runnerUp) {
        for (const e of runnerUp.evidence) {
          evidence.push({ ...e, factor: `${runnerUp.name}: ${e.factor}` });
        }
      }

      const ineligible = ranked.filter((p) => !p.eligible);
      const summary = !leader.eligible
        ? `Every option carries a designation that rules them out; ${leader.name} is listed ${leader.injury}.`
        : margin !== null && margin < 1
          ? `${leader.name} by a hair over ${runnerUp?.name} (${margin} points). This is close to a coin flip.`
          : `Start ${leader.name}${runnerUp ? ` over ${runnerUp.name}` : ""}${margin !== null ? `, by ${margin} projected points` : ""}.`;

      const caveats = evaluationCaveats(result);
      if (ineligible.length > 0) {
        caveats.push(
          `Ruled out by injury designation: ${ineligible.map((p) => `${p.name} (${p.injury})`).join(", ")}.`,
        );
      }

      return toolResult(
        envelope({
          summary,
          data: {
            lean: leader.eligible ? leader.name : null,
            margin,
            players: ranked.map(brief),
          },
          season,
          week,
          now,
          ...(leagueId ? { leagueId } : {}),
          evidence,
          confidence: conf,
          caveats,
          sources: [
            { name: "sleeper", asOf: now.toISOString() },
            { name: "nflverse", asOf: now.toISOString() },
          ],
        }),
      );
    }),
  );

  server.registerTool(
    "recommend_lineup",
    {
      description:
        "The optimal starting lineup for the owner's team this week, slot by slot, with the " +
        "runner-up and margin for each decision, and which changes to make against the lineup " +
        "currently set on Sleeper. Handles FLEX, REC_FLEX and IDP_FLEX eligibility. Use this " +
        "for 'set my lineup' or 'who should I start this week'.",
      inputSchema: {
        leagueId: z.string().optional(),
        week: z.number().int().min(1).max(18).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("recommend_lineup", ctx.now, async ({ leagueId: explicit, week: w }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx, w);
      const leagueId = await resolveLeagueId(ctx, explicit);
      if (!leagueId) {
        return degraded({
          data: null,
          season,
          week,
          now,
          failure: "No league id given and no default is set.",
        });
      }

      const roster = await loadRosterRows(ctx, leagueId, now);
      if (!roster) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: `No roster in league ${leagueId} belongs to ${ctx.env.SLEEPER_USERNAME}.`,
        });
      }

      const result = await evaluatePlayers(ctx.env.DB, roster.rows, season, week);
      const byId = new Map(result.players.map((p) => [p.canonicalId, p]));

      const candidates: LineupCandidate[] = result.players.map((p) => ({
        canonicalId: p.canonicalId,
        name: p.name,
        position: p.position,
        fantasyPositions: p.fantasyPositions,
        points: p.points,
        eligible: p.eligible,
      }));

      const lineup = optimizeLineup(roster.rosterPositions, candidates);

      // Current starters are Sleeper ids; map them to canonical for comparison.
      const currentCanonical = roster.starters
        .filter((id) => id && id !== "0")
        .map((id) => roster.bySleeper.get(id)?.canonical_id)
        .filter((x): x is string => !!x);
      const delta = lineupDelta(currentCanonical, lineup);

      const slots = lineup.assignments.map((a) => {
        const p = a.player ? byId.get(a.player.canonicalId) : null;
        return {
          slot: a.slot,
          player: a.player?.name ?? null,
          canonicalId: a.player?.canonicalId ?? null,
          projected: a.player?.points === null || !a.player ? null : roundPoints(a.player.points),
          opponent: p?.opponent ? `${p.isHome ? "vs" : "@"} ${p.opponent}` : null,
          matchupRank: p?.matchupRank ?? null,
          runnerUp: a.runnerUp?.name ?? null,
          margin: a.margin,
          closeCall: a.margin !== null && a.margin < 1.5,
        };
      });

      // Start and sit lists are reported separately rather than paired: the optimizer
      // reshuffles across slots, so there is no honest one-to-one "X in place of Y".
      const changes = {
        start: delta.benchToStart.map((p) => ({
          name: p.name,
          position: p.position,
          projected: p.points === null ? null : roundPoints(p.points),
        })),
        sit: delta.startToBench
          .map((id) => byId.get(id))
          .filter((p): p is EvaluatedPlayer => !!p)
          .map((p) => ({
            name: p.name,
            position: p.position,
            projected: p.points === null ? null : roundPoints(p.points),
            reason: !p.eligible ? `listed ${p.injury}` : "outscored by a bench option",
          })),
      };
      const changeCount = changes.start.length;

      const caveats = evaluationCaveats(result);
      if (lineup.unfilledSlots.length > 0) {
        caveats.push(
          `No eligible player available for: ${lineup.unfilledSlots.join(", ")}. ` +
            "Check the waiver wire.",
        );
      }
      const closeCalls = slots.filter((s) => s.closeCall).length;
      if (closeCalls > 0) {
        caveats.push(
          `${closeCalls} slot decisions are within 1.5 projected points, which is inside the ` +
            "noise of any projection. Treat those as toss-ups.",
        );
      }

      const conf = decisionConfidence(
        result.players.find((p) => p.canonicalId === lineup.assignments[0]?.player?.canonicalId) ??
          (result.players[0] as EvaluatedPlayer),
        null,
      );

      return toolResult(
        envelope({
          summary:
            changeCount === 0
              ? `The lineup already set is optimal. Projected ${lineup.projectedTotal} points.`
              : `${changeCount} change${changeCount === 1 ? "" : "s"} recommended; ` +
                `projected ${lineup.projectedTotal} points after them.`,
          data: {
            teamName: roster.teamName,
            projectedTotal: lineup.projectedTotal,
            slots,
            changes,
            bench: lineup.bench
              .slice()
              .sort((a, b) => (b.points ?? -1) - (a.points ?? -1))
              .slice(0, 8)
              .map((b) => ({
                name: b.name,
                position: b.position,
                projected: b.points === null ? null : roundPoints(b.points),
              })),
          },
          season,
          week,
          now,
          leagueId,
          confidence: conf,
          caveats,
          detail: "full",
          sources: [
            { name: "sleeper", asOf: now.toISOString() },
            { name: "nflverse", asOf: now.toISOString() },
          ],
        }),
      );
    }),
  );

  server.registerTool(
    "get_player_profile",
    {
      description:
        "Everything known about one player for a week: injury, recent scoring, usage trend, " +
        "projection with floor and ceiling, opponent matchup grade and game environment. Use " +
        "for 'how is X looking' or 'should I be worried about X'. For choosing between " +
        "players, use compare_players instead.",
      inputSchema: {
        playerId: z.string().describe("canonicalId from search_players"),
        leagueId: z.string().optional(),
        week: z.number().int().min(1).max(18).optional(),
        detail: z.enum(["brief", "full"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler(
      "get_player_profile",
      ctx.now,
      async ({ playerId, leagueId: explicit, week: w, detail }) => {
        const now = ctx.now();
        const { season, week } = await resolveSeasonWeek(ctx, w);
        const leagueId = await resolveLeagueId(ctx, explicit);

        const rowMap = await ctx.players.byCanonicalIds([playerId]);
        const row = rowMap.get(playerId);
        if (!row) {
          return degraded({
            data: null,
            season,
            week,
            now,
            failure: `No player with canonicalId ${playerId}. Use search_players first.`,
          });
        }

        const result = await evaluatePlayers(ctx.env.DB, [row], season, week);
        const p = result.players[0] as EvaluatedPlayer;

        const recent = p.recentPoints.map(roundPoints);
        const avg =
          recent.length > 0 ? roundPoints(recent.reduce((a, b) => a + b, 0) / recent.length) : null;

        const summaryParts = [`${p.name}, ${p.position} ${p.team ?? "free agent"}`];
        if (p.opponent) summaryParts.push(`${p.isHome ? "vs" : "@"} ${p.opponent} in week ${week}`);
        if (p.points !== null) summaryParts.push(`projected ${roundPoints(p.points)}`);
        if (p.injury !== "healthy") summaryParts.push(`listed ${p.injury}`);

        return toolResult(
          envelope({
            summary: `${summaryParts.join(", ")}.`,
            data: {
              ...brief(p),
              age: row.age,
              yearsExp: row.years_exp,
              byeWeek: row.bye_week,
              depthChartOrder: row.depth_chart_order,
              injuryDetail: p.injuryNote,
              recentPoints: recent,
              recentAverage: avg,
              usageTrends: p.trend,
              rangeBasis: p.rangeBasis,
              sources: p.sources,
              ...(detail === "full" ? { kickoff: p.kickoff, roof: p.roof } : {}),
            },
            season,
            week,
            now,
            ...(leagueId ? { leagueId } : {}),
            evidence: p.evidence,
            caveats: evaluationCaveats(result),
            detail: detail ?? "brief",
            sources: [
              { name: "sleeper", asOf: now.toISOString() },
              { name: "nflverse", asOf: now.toISOString() },
            ],
          }),
        );
      },
    ),
  );
}

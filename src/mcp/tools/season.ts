import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { roundPct, roundPoints } from "../../domain/envelope";
import { type LineupCandidate, optimizeLineup } from "../../engine/lineup";
import { lineupSigma, playoffOutlook, swingPlayers, winProbability } from "../../engine/matchup";
import { syncLeague } from "../../jobs/sync-league";
import { AnalyticsRepo, indexDvp, indexGames } from "../../storage/d1/analytics";
import type { PlayerRow } from "../../storage/d1/players";
import { resolveLeagueId, resolveSeasonWeek, sleeperUserId, type ToolContext } from "../context";
import { degraded, envelope, toolResult } from "../envelope";
import { type EvaluatedPlayer, evaluatePlayers, evaluationCaveats } from "../evaluate";
import { safeHandler } from "../safe";

/** Optimal lineup and its spread, for one team's roster. */
async function projectTeam(
  ctx: ToolContext,
  rows: readonly PlayerRow[],
  rosterPositions: readonly string[],
  season: number,
  week: number,
): Promise<{ mean: number; sigma: number; starters: EvaluatedPlayer[]; caveats: string[] }> {
  const result = await evaluatePlayers(ctx.env.DB, rows, season, week);
  const byId = new Map(result.players.map((p) => [p.canonicalId, p]));

  const candidates: LineupCandidate[] = result.players.map((p) => ({
    canonicalId: p.canonicalId,
    name: p.name,
    position: p.position,
    fantasyPositions: p.fantasyPositions,
    points: p.points,
    eligible: p.eligible,
  }));

  const lineup = optimizeLineup(rosterPositions, candidates);
  const starters = lineup.assignments
    .map((a) => (a.player ? byId.get(a.player.canonicalId) : null))
    .filter((p): p is EvaluatedPlayer => !!p);

  const bands = starters
    .filter((p) => p.floor !== null && p.ceiling !== null)
    .map((p) => ({ floor: p.floor as number, ceiling: p.ceiling as number }));

  return {
    mean: lineup.projectedTotal,
    sigma: lineupSigma(bands),
    starters,
    caveats: evaluationCaveats(result),
  };
}

export function registerSeasonTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_matchup_preview",
    {
      description:
        "This week's head-to-head: the owner's projected total against their opponent's, a " +
        "win probability, and the players whose outcome swings the result most. Use for 'how " +
        "do I look this week' or 'can I win this matchup'.",
      inputSchema: {
        leagueId: z.string().optional(),
        week: z.number().int().min(1).max(18).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_matchup_preview", ctx.now, async ({ leagueId: explicit, week: w }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx, w);
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
      if (!myTeam) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: `No roster in league ${leagueId} belongs to ${ctx.env.SLEEPER_USERNAME}.`,
        });
      }

      const matchups = await ctx.sleeper.getMatchups(leagueId, week);
      const mine = matchups.find((m) => String(m.roster_id) === myTeam.teamId);
      const opponentEntry =
        mine?.matchup_id != null
          ? matchups.find(
              (m) => m.matchup_id === mine.matchup_id && String(m.roster_id) !== myTeam.teamId,
            )
          : undefined;

      if (!opponentEntry) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: `No opponent is scheduled for week ${week} yet.`,
        });
      }

      const opponentTeam = teams.find((t) => t.teamId === String(opponentEntry.roster_id));
      if (!opponentTeam) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: "The opponent's roster could not be loaded.",
        });
      }

      const notStartable = (t: typeof myTeam) => new Set([...t.taxi, ...t.reserve]);
      const myRows = [
        ...(
          await ctx.players.bySleeperIds(
            myTeam.playerIds.filter((id) => !notStartable(myTeam).has(id)),
          )
        ).values(),
      ];
      const theirRows = [
        ...(
          await ctx.players.bySleeperIds(
            opponentTeam.playerIds.filter((id) => !notStartable(opponentTeam).has(id)),
          )
        ).values(),
      ];

      const [me, them] = await Promise.all([
        projectTeam(ctx, myRows, league.rosterPositions, season, week),
        projectTeam(ctx, theirRows, league.rosterPositions, season, week),
      ]);

      const p = winProbability(
        { mean: me.mean, sigma: me.sigma },
        { mean: them.mean, sigma: them.sigma },
      );

      const swings = swingPlayers(
        me.starters
          .filter((s) => s.floor !== null && s.ceiling !== null)
          .map((s) => ({
            name: s.name,
            position: s.position,
            floor: s.floor as number,
            ceiling: s.ceiling as number,
          })),
        3,
      );

      const margin = roundPoints(me.mean - them.mean);
      return toolResult(
        envelope({
          summary:
            `${roundPct(p * 100)}% to beat ${opponentTeam.displayName}: ` +
            `${me.mean} projected against ${them.mean}, a ${Math.abs(margin)}-point ` +
            `${margin >= 0 ? "edge" : "deficit"}.`,
          data: {
            me: { team: myTeam.displayName, projected: me.mean, spread: roundPoints(me.sigma) },
            opponent: {
              team: opponentTeam.displayName,
              projected: them.mean,
              spread: roundPoints(them.sigma),
            },
            winProbability: Math.round(p * 100) / 100,
            margin,
            swingPlayers: swings.map((s) => ({
              name: s.name,
              position: s.position,
              floor: roundPoints(s.floor),
              ceiling: roundPoints(s.ceiling),
              range: roundPoints(s.ceiling - s.floor),
            })),
          },
          season,
          week,
          now,
          leagueId,
          confidence: 0.6,
          caveats: [
            ...new Set([...me.caveats, ...them.caveats]),
            "Win probability treats each starter as independent; a quarterback and their " +
              "receiver rise and fall together, so real outcomes are slightly more extreme " +
              "than this suggests.",
          ],
          detail: "full",
          sources: [{ name: "sleeper", asOf: now.toISOString() }],
        }),
      );
    }),
  );

  server.registerTool(
    "get_playoff_outlook",
    {
      description:
        "How each rostered player's schedule looks during the fantasy playoff weeks, ranked " +
        "by matchup difficulty, with bye conflicts flagged and upgrade suggestions. Use when " +
        "planning ahead, deciding who to hold, or judging a trade's playoff impact.",
      inputSchema: { leagueId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_playoff_outlook", ctx.now, async ({ leagueId: explicit }) => {
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
      const { league, myTeam } = await syncLeague(ctx.sleeper, ctx.env.DB, leagueId, userId, now);
      if (!myTeam) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: `No roster in league ${leagueId} belongs to ${ctx.env.SLEEPER_USERNAME}.`,
        });
      }

      // Sleeper's regular season runs through week 17 in most leagues; treat every week
      // from playoffWeekStart to 17 as a playoff week.
      const playoffWeeks: number[] = [];
      for (let wk = league.playoffWeekStart; wk <= 17; wk++) playoffWeeks.push(wk);

      const analytics = new AnalyticsRepo(ctx.env.DB);
      const dvp = indexDvp(await analytics.defenseVsPosition(season, week));

      // One schedule lookup per playoff week, then everything is in memory.
      const schedules = new Map<number, ReturnType<typeof indexGames>>();
      for (const wk of playoffWeeks) {
        schedules.set(wk, indexGames(await analytics.games(season, wk)));
      }

      const rows = [
        ...(
          await ctx.players.bySleeperIds(myTeam.playerIds.filter((id) => !myTeam.taxi.includes(id)))
        ).values(),
      ];

      const outlooks = rows.map((r) =>
        playoffOutlook(
          {
            canonicalId: r.canonical_id,
            name: r.name,
            position: r.position,
            team: r.team,
            byeWeek: r.bye_week,
          },
          playoffWeeks,
          (team, wk) => schedules.get(wk)?.get(team)?.opponent ?? null,
          (opponent, position) =>
            dvp.get(opponent, position as Parameters<typeof dvp.get>[1])?.rank ?? null,
          league.numTeams > 0 ? 32 : 32,
        ),
      );

      const ranked = [...outlooks]
        .filter((o) => o.score !== null)
        .sort((a, b) => (b.score as number) - (a.score as number));

      const best = ranked.slice(0, 5);
      const worst = ranked.slice(-5).reverse();
      const byeIssues = outlooks.filter((o) => o.byeConflicts.length > 0);
      const unknown = outlooks.filter((o) => o.score === null);

      const caveats: string[] = [];
      if (unknown.length > 0) {
        caveats.push(
          `${unknown.length} players have no playoff-week schedule or matchup data yet ` +
            "and are omitted from the ranking.",
        );
      }
      caveats.push(
        "Matchup difficulty for weeks that far out is based on defences as they are rated " +
          "today; injuries and form between now and then will move these substantially.",
      );

      return toolResult(
        envelope({
          summary:
            `Playoff weeks ${playoffWeeks.join(", ")}. Best schedules: ` +
            `${best.map((b) => b.name).join(", ") || "none rated"}.` +
            (byeIssues.length > 0 ? ` ${byeIssues.length} players have a bye conflict.` : ""),
          data: {
            playoffWeeks,
            bestSchedules: best.map(describeOutlook),
            worstSchedules: worst.map(describeOutlook),
            byeConflicts: byeIssues.map((o) => ({ name: o.name, weeks: o.byeConflicts })),
          },
          season,
          week,
          now,
          leagueId,
          caveats,
          detail: "full",
          sources: [{ name: "nflverse", asOf: now.toISOString() }],
        }),
      );
    }),
  );
}

function describeOutlook(o: ReturnType<typeof playoffOutlook>) {
  return {
    name: o.name,
    position: o.position,
    score: o.score,
    weeks: o.weeks.map((w) => ({
      week: w.week,
      opponent: w.opponent,
      rank: w.rank,
      onBye: w.onBye,
    })),
  };
}

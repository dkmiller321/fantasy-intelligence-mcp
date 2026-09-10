import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { inferScoringFormat } from "../../engine/scoring";
import { startingSlots } from "../../engine/slots";
import { syncLeague, toLeague } from "../../jobs/sync-league";
import { resolveLeagueId, resolveSeasonWeek, sleeperUserId, type ToolContext } from "../context";
import { degraded, envelope, toolResult } from "../envelope";
import { safeHandler } from "../safe";

export function registerLeagueTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_my_leagues",
    {
      description:
        "Every Sleeper league the owner plays in this season, and which one is the default " +
        "for tools that take an optional leagueId. Call this when the user mentions a league " +
        "by name, or when you need a leagueId and none was given.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_my_leagues", ctx.now, async () => {
      const now = ctx.now();
      try {
        const { season, week } = await resolveSeasonWeek(ctx);
        const userId = await sleeperUserId(ctx);
        const raw = await ctx.sleeper.getUserLeagues(userId, season);
        const defaultId = await resolveLeagueId(ctx);

        const leagues = raw.map((l) => {
          const league = toLeague(l, "");
          return {
            leagueId: league.id,
            name: league.name,
            season: league.season,
            teams: league.numTeams,
            scoringFormat: inferScoringFormat(league.scoring),
            pointsPerReception: league.scoring.rec ?? 0,
            isDynasty: league.isDynasty,
            startingSlots: startingSlots(league.rosterPositions).length,
            hasIdp: league.rosterPositions.some((p) => ["DL", "LB", "DB", "IDP_FLEX"].includes(p)),
            isDefault: league.id === defaultId,
          };
        });

        const names = leagues.map((l) => l.name).join(", ");
        return toolResult(
          envelope({
            summary:
              leagues.length === 1
                ? `The owner plays in one ${season} league: ${names}.`
                : `The owner plays in ${leagues.length} ${season} leagues: ${names}.`,
            data: { leagues, defaultLeagueId: defaultId },
            season,
            week,
            now,
            sources: [{ name: "sleeper", asOf: now.toISOString() }],
          }),
        );
      } catch (err) {
        return degraded({
          data: { leagues: [], defaultLeagueId: null },
          season: 0,
          week: 0,
          now,
          failure: `Could not reach Sleeper (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
    }),
  );

  server.registerTool(
    "set_default_league",
    {
      description:
        "Remember which league to use when a tool is called without a leagueId. Use only " +
        "when the owner explicitly asks to switch leagues; it writes a preference.",
      inputSchema: { leagueId: z.string().describe("Sleeper league id from get_my_leagues") },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    safeHandler("set_default_league", ctx.now, async ({ leagueId }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx).catch(() => ({ season: 0, week: 0 }));
      await ctx.prefs.setDefaultLeague(
        ctx.subject,
        leagueId,
        ctx.env.SLEEPER_USERNAME,
        now.toISOString(),
      );
      return toolResult(
        envelope({
          summary: `Default league set to ${leagueId}.`,
          data: { defaultLeagueId: leagueId },
          season,
          week,
          now,
          leagueId,
          sources: [],
        }),
      );
    }),
  );

  server.registerTool(
    "get_league",
    {
      description:
        "Full settings and standings for one league: scoring, starting slots, playoff weeks, " +
        "waiver rules, and every team's record. Call this before giving lineup or trade advice " +
        "so the scoring format and roster shape are known. Points-per-reception and IDP scoring " +
        "vary widely and change which players are worth starting.",
      inputSchema: {
        leagueId: z.string().optional().describe("Defaults to the owner's default league"),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_league", ctx.now, async ({ leagueId: explicit }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx).catch(() => ({ season: 0, week: 0 }));
      const leagueId = await resolveLeagueId(ctx, explicit);
      if (!leagueId) {
        return degraded({
          data: null,
          season,
          week,
          now,
          failure: "No league id given and no default is set. Call get_my_leagues first.",
        });
      }

      try {
        const userId = await sleeperUserId(ctx);
        const { league, teams, myTeam } = await syncLeague(
          ctx.sleeper,
          ctx.env.DB,
          leagueId,
          userId,
          now,
        );

        const slots = startingSlots(league.rosterPositions);
        const standings = [...teams]
          .sort(
            (a, b) =>
              b.record.w - a.record.w ||
              a.record.l - b.record.l ||
              b.record.pointsFor - a.record.pointsFor,
          )
          .map((t, i) => ({
            rank: i + 1,
            teamId: t.teamId,
            name: t.displayName,
            record: `${t.record.w}-${t.record.l}${t.record.t ? `-${t.record.t}` : ""}`,
            pointsFor: Math.round(t.record.pointsFor * 10) / 10,
            isMine: t.teamId === league.myTeamId,
            ...(t.faabRemaining !== undefined ? { faabRemaining: t.faabRemaining } : {}),
          }));

        const caveats: string[] = [];
        if (!myTeam) {
          caveats.push(
            `No roster in this league is owned by Sleeper user ${ctx.env.SLEEPER_USERNAME}; ` +
              "team-specific advice will not work.",
          );
        }

        return toolResult(
          envelope({
            summary:
              `${league.name}: ${league.numTeams}-team ${league.isDynasty ? "dynasty" : "redraft"}, ` +
              `${league.scoring.rec ?? 0} PPR, ${slots.length} starters, playoffs begin week ` +
              `${league.playoffWeekStart}.`,
            data: {
              leagueId: league.id,
              name: league.name,
              season: league.season,
              numTeams: league.numTeams,
              isDynasty: league.isDynasty,
              taxiSlots: league.taxiSlots,
              scoringFormat: inferScoringFormat(league.scoring),
              scoring: league.scoring,
              rosterPositions: league.rosterPositions,
              startingSlots: slots,
              playoffWeekStart: league.playoffWeekStart,
              playoffTeams: league.playoffTeams,
              waiverType: league.waiverType,
              faabBudget: league.faabBudget ?? null,
              myTeamId: league.myTeamId,
              standings,
            },
            season: league.season,
            week,
            now,
            leagueId,
            caveats,
            detail: "full",
            sources: [{ name: "sleeper", asOf: now.toISOString() }],
          }),
        );
      } catch (err) {
        return degraded({
          data: null,
          season,
          week,
          now,
          leagueId,
          failure: `Could not load league ${leagueId} (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
    }),
  );
}

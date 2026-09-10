import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Position } from "../../domain/types";
import { canFill, startingSlots } from "../../engine/slots";
import { isUnresolved } from "../../ids/canonical";
import { normalizeName } from "../../ids/normalize";
import { syncLeague } from "../../jobs/sync-league";
import { rowToPlayer, type PlayerRow } from "../../storage/d1/players";
import { resolveLeagueId, resolveSeasonWeek, sleeperUserId, type ToolContext } from "../context";
import { degraded, envelope, toolResult } from "../envelope";
import { safeHandler } from "../safe";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF", "DL", "LB", "DB"] as const;

function injuryLabel(row: PlayerRow): string | null {
  if (!row.injury_status || row.injury_status === "healthy") return null;
  const part = row.injury_body_part ? ` (${row.injury_body_part})` : "";
  return `${row.injury_status}${part}`;
}

export function registerPlayerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_players",
    {
      description:
        "Find players by name and resolve them to the canonicalId that every other tool " +
        "expects. Always call this first when the user names a player, rather than guessing " +
        "an id. Returns at most 10 candidates, active players on a team ranked first.",
      inputSchema: {
        query: z.string().min(2).describe("Full or partial player name"),
        position: z
          .enum(POSITIONS)
          .optional()
          .describe("Narrow to one fantasy position. DL, LB and DB are IDP."),
        limit: z.number().int().min(1).max(10).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("search_players", ctx.now, async ({ query, position, limit }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx).catch(() => ({ season: 0, week: 0 }));
      const rows = await ctx.players.search(normalizeName(query), position ?? null, limit ?? 10);

      const candidates = rows.map((r) => ({
        canonicalId: r.canonical_id,
        name: r.name,
        position: r.position,
        fantasyPositions: JSON.parse(r.fantasy_positions) as Position[],
        team: r.team,
        status: r.status,
        injury: injuryLabel(r),
        age: r.age,
        yearsExp: r.years_exp,
      }));

      const caveats: string[] = [];
      if (candidates.length === 0) {
        caveats.push(
          `No player matched "${query}". Try a last name only, or check the spelling.`,
        );
      }

      return toolResult(
        envelope({
          summary:
            candidates.length === 0
              ? `No player matched "${query}".`
              : candidates.length === 1
                ? `${candidates[0]?.name}, ${candidates[0]?.position} ${candidates[0]?.team ?? "free agent"}.`
                : `${candidates.length} players match "${query}".`,
          data: { candidates },
          season,
          week,
          now,
          caveats,
          sources: [{ name: "sleeper", asOf: (await ctx.players.freshness()) ?? now.toISOString() }],
        }),
      );
    }),
  );

  server.registerTool(
    "get_roster",
    {
      description:
        "The owner's full roster for a league: every player with position, team, bye week, " +
        "injury status, and which roster slot they currently occupy. Taxi-squad and IR players " +
        "are listed separately because they cannot be started. Use this to answer 'who is on my " +
        "team' and as the starting point for lineup questions.",
      inputSchema: {
        leagueId: z.string().optional(),
        week: z.number().int().min(1).max(18).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_roster", ctx.now, async ({ leagueId: explicit, week: explicitWeek }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx, explicitWeek).catch(() => ({
        season: 0,
        week: explicitWeek ?? 0,
      }));
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

        const rows = await ctx.players.bySleeperIds(myTeam.playerIds);
        const slots = startingSlots(league.rosterPositions);
        const taxi = new Set(myTeam.taxi);
        const reserve = new Set(myTeam.reserve);
        const starterIds = new Set(myTeam.starters.filter((id) => id && id !== "0"));

        const describe = (sleeperId: string) => {
          const r = rows.get(sleeperId);
          if (!r) {
            return {
              sleeperId,
              canonicalId: null,
              name: "unknown player",
              position: null,
              team: null,
              injury: null,
              unresolved: true,
            };
          }
          const p = rowToPlayer(r);
          return {
            canonicalId: p.canonicalId,
            name: p.name,
            position: p.position,
            fantasyPositions: p.fantasyPositions,
            team: p.team,
            byeWeek: p.byeWeek,
            injury: injuryLabel(r),
            age: p.age ?? null,
            depthChartOrder: p.depthChartOrder ?? null,
            starting: starterIds.has(sleeperId),
            unresolved: isUnresolved(p.canonicalId),
          };
        };

        const active = myTeam.playerIds
          .filter((id) => !taxi.has(id) && !reserve.has(id))
          .map(describe);
        const taxiPlayers = myTeam.taxi.map(describe);
        const reservePlayers = myTeam.reserve.map(describe);

        // Which starting slots the current lineup leaves empty.
        const filled = myTeam.starters.filter((id) => id && id !== "0").length;
        const caveats: string[] = [];
        if (filled < slots.length) {
          caveats.push(
            `${slots.length - filled} of ${slots.length} starting slots are empty in the ` +
              "lineup currently set on Sleeper.",
          );
        }
        const unresolvedCount = active.filter((p) => p.unresolved).length;
        if (unresolvedCount > 0) {
          caveats.push(
            `${unresolvedCount} rostered players have no cross-provider id, usually 2026 ` +
              "rookies. Their historical stats and matchup grades are unavailable.",
          );
        }
        const injured = active.filter((p) => p.injury);
        if (injured.length > 0) {
          caveats.push(
            `Injury designations: ${injured.map((p) => `${p.name} ${p.injury}`).join(", ")}.`,
          );
        }

        return toolResult(
          envelope({
            summary:
              `${myTeam.displayName}: ${active.length} active players, ${taxiPlayers.length} on ` +
              `taxi, ${reservePlayers.length} on IR. ${slots.length} starting slots ` +
              `(${slots.filter((s) => ["DL", "LB", "DB", "IDP_FLEX"].includes(s)).length} IDP).`,
            data: {
              leagueId,
              teamId: myTeam.teamId,
              teamName: myTeam.displayName,
              record: myTeam.record,
              faabRemaining: myTeam.faabRemaining ?? null,
              startingSlots: slots,
              players: active,
              taxi: taxiPlayers,
              reserve: reservePlayers,
            },
            season,
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
          failure: `Could not load the roster (${err instanceof Error ? err.message : String(err)}).`,
        });
      }
    }),
  );
}

/** Exported for the lineup tools in later phases. */
export function slotFor(
  slots: readonly string[],
  fantasyPositions: readonly Position[],
): string | null {
  return slots.find((s) => canFill(s, fantasyPositions)) ?? null;
}

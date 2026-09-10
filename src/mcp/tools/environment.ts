import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { roundPoints } from "../../domain/envelope";
import { CONFIG } from "../../engine/config";
import { normalizeTeam } from "../../ids/normalize";
import { AnalyticsRepo } from "../../storage/d1/analytics";
import { resolveSeasonWeek, type ToolContext } from "../context";
import { degraded, envelope, toolResult } from "../envelope";
import { safeHandler } from "../safe";

export function registerEnvironmentTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_game_environment",
    {
      description:
        "Kickoff time, roof, weather forecast, betting spread and total, and the implied " +
        "points each team is expected to score, for every game in a week. Implied team total " +
        "is the single best predictor of how much fantasy scoring a game will produce. Use " +
        "when asked about weather, a game's pace, or whether an offence is in a good spot.",
      inputSchema: {
        week: z.number().int().min(1).max(18).optional(),
        team: z.string().optional().describe("NFL abbreviation; returns just that team's game"),
      },
      annotations: { readOnlyHint: true },
    },
    safeHandler("get_game_environment", ctx.now, async ({ week: w, team }) => {
      const now = ctx.now();
      const { season, week } = await resolveSeasonWeek(ctx, w);
      const analytics = new AnalyticsRepo(ctx.env.DB);
      const games = await analytics.games(season, week);

      if (games.length === 0) {
        return degraded({
          data: { games: [] },
          season,
          week,
          now,
          failure: `No schedule loaded for ${season} week ${week}. The nflverse ETL may not have run.`,
        });
      }

      const wanted = normalizeTeam(team ?? null);
      const filtered = wanted ? games.filter((g) => g.home === wanted || g.away === wanted) : games;

      if (wanted && filtered.length === 0) {
        return degraded({
          data: { games: [] },
          season,
          week,
          now,
          failure: `No week ${week} game found for ${wanted}. They may be on bye.`,
        });
      }

      const rows = filtered
        .map((g) => {
          const outdoor = g.roof === "outdoors" || g.roof === "open";
          const windy =
            outdoor && g.wind_mph !== null && g.wind_mph >= CONFIG.environment.windThresholdMph;
          return {
            gameId: g.id,
            kickoff: g.kickoff,
            away: g.away,
            home: g.home,
            roof: g.roof,
            spread: g.spread,
            favourite: g.spread === null ? null : g.spread > 0 ? g.home : g.away,
            total: g.total,
            impliedHome: g.implied_home === null ? null : roundPoints(g.implied_home),
            impliedAway: g.implied_away === null ? null : roundPoints(g.implied_away),
            weather: outdoor
              ? {
                  tempF: g.temp_f,
                  windMph: g.wind_mph,
                  windy,
                }
              : null,
          };
        })
        .sort((a, b) => (a.kickoff ?? "").localeCompare(b.kickoff ?? ""));

      const withTotals = rows.filter((r) => r.total !== null);
      const highest = [...withTotals].sort((a, b) => (b.total as number) - (a.total as number))[0];
      const missingLines = rows.length - withTotals.length;
      const windyGames = rows.filter((r) => r.weather?.windy);

      const caveats: string[] = [];
      if (missingLines > 0) {
        caveats.push(
          `${missingLines} of ${rows.length} games have no betting line posted yet, so their ` +
            "implied totals are unknown and game environment is treated as neutral.",
        );
      }
      const noWeather = rows.filter((r) => r.weather && r.weather.tempF === null).length;
      if (noWeather > 0) {
        caveats.push(
          `${noWeather} outdoor games have no forecast yet; Open-Meteo reaches about two ` +
            "weeks ahead.",
        );
      }
      if (windyGames.length > 0) {
        caveats.push(
          `Wind at or above ${CONFIG.environment.windThresholdMph} mph in: ` +
            `${windyGames.map((g) => `${g.away} at ${g.home}`).join(", ")}. This suppresses ` +
            "passing games and kickers.",
        );
      }

      const summary = wanted
        ? describeOne(rows[0] as (typeof rows)[number])
        : highest
          ? `${rows.length} games in week ${week}. Highest total: ${highest.away} at ` +
            `${highest.home} at ${highest.total}.`
          : `${rows.length} games in week ${week}; no betting lines posted yet.`;

      return toolResult(
        envelope({
          summary,
          data: { games: rows },
          season,
          week,
          now,
          caveats,
          detail: "full",
          sources: [
            { name: "nflverse", asOf: now.toISOString() },
            { name: "open-meteo", asOf: now.toISOString() },
          ],
        }),
      );
    }),
  );
}

function describeOne(g: {
  away: string;
  home: string;
  total: number | null;
  roof: string | null;
  impliedHome: number | null;
  impliedAway: number | null;
  weather: { tempF: number | null; windMph: number | null; windy: boolean } | null;
}): string {
  const parts = [`${g.away} at ${g.home}`];
  if (g.total !== null) {
    parts.push(`total ${g.total}, implied ${g.away} ${g.impliedAway} / ${g.home} ${g.impliedHome}`);
  } else {
    parts.push("no betting line posted yet");
  }
  if (g.roof && g.roof !== "outdoors") parts.push(g.roof);
  else if (g.weather?.windMph !== null && g.weather !== null) {
    parts.push(`${Math.round(g.weather.windMph as number)} mph wind`);
  }
  return `${parts.join(", ")}.`;
}

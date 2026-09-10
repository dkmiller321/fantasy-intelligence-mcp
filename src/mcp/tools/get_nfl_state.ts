import type { McpServer } from "@modelcontextprotocol/server";
import { degraded, envelope, toolResult } from "../envelope";
import type { ToolContext } from "../server";

interface NflStateData {
  season: number;
  week: number;
  seasonType: string;
  seasonStartDate: string;
  previousSeason: number;
}

export function registerNflState(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_nfl_state",
    {
      description:
        "The current NFL season, week and season type (pre/regular/post). Call this first " +
        "whenever a question says 'this week', 'right now' or 'this season', so later tools " +
        "get the correct week. Returns no player or league data.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const now = ctx.now();
      try {
        const s = await ctx.sleeper.getNflState();
        const data: NflStateData = {
          season: Number(s.season),
          week: s.week,
          seasonType: s.season_type,
          seasonStartDate: s.season_start_date,
          previousSeason: Number(s.previous_season),
        };
        return toolResult(
          envelope({
            summary: `NFL ${data.season} is in week ${data.week} of the ${data.seasonType} season.`,
            data,
            season: data.season,
            week: data.week,
            now,
            sources: [{ name: "sleeper", asOf: now.toISOString() }],
          }),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return degraded<NflStateData | null>({
          data: null,
          season: 0,
          week: 0,
          now,
          failure: `Sleeper's season-state endpoint is unreachable (${reason}). Retry shortly.`,
        });
      }
    },
  );
}

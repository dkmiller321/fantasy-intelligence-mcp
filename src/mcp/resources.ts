import type { McpServer } from "@modelcontextprotocol/server";
import { syncLeague } from "../jobs/sync-league";
import { resolveLeagueId, sleeperUserId, type ToolContext } from "./context";

/**
 * Resources expose reference data the model may want to read without spending a tool
 * call on it: league settings that never change mid-season, and a player's identity.
 */
export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "league-settings",
    "league://settings",
    {
      title: "League settings",
      description: "Scoring, roster slots, playoff weeks and waiver rules for the default league.",
      mimeType: "application/json",
    },
    async (uri) => {
      const leagueId = await resolveLeagueId(ctx);
      if (!leagueId) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "no default league" }),
            },
          ],
        };
      }
      const userId = await sleeperUserId(ctx);
      const { league } = await syncLeague(ctx.sleeper, ctx.env.DB, leagueId, userId, ctx.now());
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              leagueId: league.id,
              name: league.name,
              season: league.season,
              numTeams: league.numTeams,
              isDynasty: league.isDynasty,
              taxiSlots: league.taxiSlots,
              rosterPositions: league.rosterPositions,
              playoffWeekStart: league.playoffWeekStart,
              playoffTeams: league.playoffTeams,
              waiverType: league.waiverType,
              faabBudget: league.faabBudget ?? null,
              scoring: league.scoring,
            }),
          },
        ],
      };
    },
  );

  server.registerResource(
    "methodology",
    "doc://methodology",
    {
      title: "How projections are computed",
      description: "The factors behind every number this server returns, and their weights.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: METHODOLOGY,
        },
      ],
    }),
  );
}

const METHODOLOGY = `# How these numbers are produced

Every projection is deterministic arithmetic over stored data. No model is called.

1. **Points are recomputed from stat lines** against this league's own 68 scoring keys.
   Provider point totals are never trusted: for IDP they are wrong by more than an order
   of magnitude.
2. **Consensus** is a weighted mean of available sources. With one source, confidence is
   capped at 0.7.
3. **Matchup** compares the opponent's fantasy points allowed to the position against the
   league mean, as a z-score, clamped to a multiplier between 0.85 and 1.15.
4. **Game environment** uses the implied team total from the betting line, clamped to
   between 0.90 and 1.10, then applies wind and precipitation penalties outdoors only.
5. **Injury** removes out, doubtful, IR, PUP and suspended players from lineups, and
   discounts questionable players by 10% with a wider range.
6. **Composite** = consensus x matchup x environment x injury. Each factor's contribution
   is reported in \`evidence\`.
7. **Confidence** = 0.5 + 0.2(source agreement) + 0.2(gap to the alternative)
   - 0.15(injury uncertainty) - 0.10(missing sources).

Early in a season the matchup grades are blended with the prior year, at full weight in
week 1 and none from week 7. Any response affected says so in \`caveats\`.
`;

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "./context";

/**
 * Prompts are the recurring questions worth one click. Each one tells the model which
 * tools to call and in what order, so a weekly routine does not depend on the user
 * remembering the sequence.
 */
export function registerPrompts(server: McpServer, _ctx: ToolContext): void {
  server.registerPrompt(
    "weekly_lineup_review",
    {
      description:
        "Full lineup review for the current week: optimal starters, close calls, and injuries.",
      argsSchema: { week: z.string().optional() },
    },
    ({ week }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Review my fantasy lineup${week ? ` for week ${week}` : " for this week"}.\n\n` +
              "Call get_nfl_state first if you need the week, then recommend_lineup. " +
              "Report the changes worth making and, for any slot the tool flags as a close " +
              "call, say plainly that it is a coin flip rather than picking a side with " +
              "false confidence. Check get_news for anything that broke since the " +
              "projections were published, and call out injury designations. Keep it short " +
              "enough to read on a phone.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "waiver_wire_wednesday",
    {
      description: "Waiver targets with suggested FAAB bids, filtered to what this roster needs.",
      argsSchema: { position: z.string().optional() },
    },
    ({ position }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              "Who should I add this week?\n\n" +
              "Call get_roster to see where I am thin, then get_waiver_targets" +
              `${position ? ` for ${position}` : ""}. Recommend at most three adds, each with ` +
              "who to drop for them and a FAAB bid. Say what my remaining budget is. If " +
              "nothing is clearly better than what I already hold, say so instead of " +
              "manufacturing a move.",
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "trade_check",
    {
      description: "Evaluate a proposed trade, including its dynasty and playoff implications.",
      argsSchema: { give: z.string(), receive: z.string() },
    },
    ({ give, receive }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Should I trade away ${give} to get ${receive}?\n\n` +
              "Resolve every name with search_players, then call evaluate_trade. This is a " +
              "dynasty league, so weigh age as well as this season's points, and check " +
              "get_playoff_outlook for how it changes my playoff weeks. Give a clear verdict " +
              "and name the single biggest risk in accepting.",
          },
        },
      ],
    }),
  );
}

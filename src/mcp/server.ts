import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "./context";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerAdviceTools } from "./tools/advice";
import { registerEnvironmentTool } from "./tools/environment";
import { registerNflState } from "./tools/get_nfl_state";
import { registerLeagueTools } from "./tools/leagues";
import { registerMarketTools } from "./tools/market";
import { registerPlayerTools } from "./tools/players";
import { registerSeasonTools } from "./tools/season";

export type { ToolContext } from "./context";
export { toolContext } from "./context";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "fantasy-intelligence", version: "0.1.0" });

  registerNflState(server, ctx);
  registerLeagueTools(server, ctx);
  registerPlayerTools(server, ctx);
  registerAdviceTools(server, ctx);
  registerEnvironmentTool(server, ctx);
  registerMarketTools(server, ctx);
  registerSeasonTools(server, ctx);

  registerPrompts(server, ctx);
  registerResources(server, ctx);

  return server;
}

import { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "./context";
import { registerNflState } from "./tools/get_nfl_state";
import { registerLeagueTools } from "./tools/leagues";
import { registerPing } from "./tools/ping";
import { registerPlayerTools } from "./tools/players";

export type { ToolContext } from "./context";
export { toolContext } from "./context";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "fantasy-intelligence", version: "0.1.0" });

  registerPing(server, ctx);
  registerNflState(server, ctx);
  registerLeagueTools(server, ctx);
  registerPlayerTools(server, ctx);

  return server;
}

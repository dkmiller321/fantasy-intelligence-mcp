import { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { SleeperProvider } from "../providers/sleeper/client";
import { registerNflState } from "./tools/get_nfl_state";
import { registerPing } from "./tools/ping";

/**
 * Providers are injected rather than constructed inside tools, so tools can be
 * exercised against recorded fixtures without network.
 */
export interface ToolContext {
  env: Env;
  now: () => Date;
  sleeper: SleeperProvider;
}

export function toolContext(env: Env, now: () => Date = () => new Date()): ToolContext {
  return { env, now, sleeper: new SleeperProvider(now) };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "fantasy-intelligence", version: "0.1.0" });

  registerPing(server, ctx);
  registerNflState(server, ctx);

  return server;
}

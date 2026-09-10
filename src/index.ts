import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env";
import { createServer, toolContext } from "./mcp/server";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, phase: 0, now: new Date().toISOString() });
    }

    const handler = createMcpHandler(() => createServer(toolContext(env)));
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

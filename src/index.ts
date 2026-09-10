import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { handleAuthorize } from "./auth/approval";
import type { Env } from "./env";
import { runScheduled } from "./jobs/scheduled";
import { toolContext } from "./mcp/context";
import { createServer } from "./mcp/server";
import { IngestRepo } from "./storage/d1/ingest";

/** Serves /mcp for requests the OAuth provider has already authenticated. */
const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(() => {
      const auth = getMcpAuthContext();
      const subject = typeof auth?.props?.subject === "string" ? auth.props.subject : "owner";
      return createServer(toolContext(env, () => new Date(), subject));
    });
    return handler(request, env, ctx);
  },
};

/** Everything that is not /mcp: the approval page, health, and the landing page. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (url.pathname === "/health") {
      const runs = await new IngestRepo(env.DB).latest().catch(() => []);
      return Response.json({
        ok: true,
        now: new Date().toISOString(),
        providers: {
          fantasypros: env.FANTASYPROS_KEY ? "configured" : "absent",
          odds: env.ODDS_API_KEY ? "configured" : "absent",
          openweather: env.OPENWEATHER_KEY ? "configured" : "absent",
        },
        ingest: runs,
      });
    }

    if (url.pathname === "/") {
      return new Response(
        "Fantasy Intelligence MCP. Add this server's /mcp endpoint as a custom connector.",
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["fantasy:read", "fantasy:write"],
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return provider.fetch(request, env, ctx);
  },

  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(event.cron, env, new Date()));
  },
} satisfies ExportedHandler<Env>;

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { handleAuthorize } from "./auth/approval";
import type { Env } from "./env";
import { runScheduled } from "./jobs/scheduled";
import { toolContext } from "./mcp/context";
import { checkRateLimit, logRequest } from "./mcp/ratelimit";
import { createServer } from "./mcp/server";
import { IngestRepo } from "./storage/d1/ingest";
import { NewsRepo } from "./storage/d1/news";
import { PlayerRepo } from "./storage/d1/players";

/** Serves /mcp for requests the OAuth provider has already authenticated. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const auth = getMcpAuthContext();
    const subject = typeof auth?.props?.subject === "string" ? auth.props.subject : "owner";

    const limit = await checkRateLimit(env, subject, new Date());
    if (!limit.allowed) {
      logRequest({
        path: "/mcp",
        method: request.method,
        subject,
        status: 429,
        ms: Date.now() - started,
        rateLimited: true,
      });
      return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(limit.resetSeconds),
        },
      });
    }

    const handler = createMcpHandler(() =>
      createServer(toolContext(env, () => new Date(), subject)),
    );
    const res = await handler(request, env, ctx);

    logRequest({
      path: "/mcp",
      method: request.method,
      subject,
      status: res.status,
      ms: Date.now() - started,
    });
    return res;
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
      return health(env);
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

/**
 * Freshness per source, read from the ingest log rather than guessed. Public and
 * deliberately free of roster data, so it can be checked without signing in.
 */
async function health(env: Env): Promise<Response> {
  const now = new Date();
  const [runs, failures, playerCount, playersAsOf, newsAsOf, projectionSources] = await Promise.all(
    [
      new IngestRepo(env.DB).latest().catch(() => []),
      new IngestRepo(env.DB).failures().catch(() => []),
      new PlayerRepo(env.DB).count().catch(() => 0),
      new PlayerRepo(env.DB).freshness().catch(() => null),
      new NewsRepo(env.DB).freshness().catch(() => null),
      env.DB.prepare(
        `SELECT source, COUNT(*) AS n, MAX(as_of) AS as_of FROM projections
         WHERE season = (SELECT MAX(season) FROM projections) GROUP BY source`,
      )
        .all<{ source: string; n: number; as_of: string }>()
        .then((r) => r.results)
        .catch(() => []),
    ],
  );

  const sources: Record<string, unknown> = {
    sleeper: "keyless",
    nflverse: "keyless",
    "open-meteo": "keyless",
    rss: "keyless",
    espn: "keyless",
    odds: "not used (nflverse supplies lines)",
  };
  for (const s of projectionSources) {
    sources[`projections:${s.source}`] = { players: s.n, asOf: s.as_of };
  }

  const ageHours = (iso: string | null): number | null =>
    iso ? Math.round(((now.getTime() - Date.parse(iso)) / 3600000) * 10) / 10 : null;

  return Response.json({
    ok: true,
    now: now.toISOString(),
    counts: { players: playerCount },
    freshness: {
      players: { asOf: playersAsOf, ageHours: ageHours(playersAsOf) },
      news: { asOf: newsAsOf, ageHours: ageHours(newsAsOf) },
    },
    // Reported from the data rather than from which environment variables are set: a key
    // can be present while the source supplied nothing, and the ingest scripts hold some
    // keys that the Worker itself never sees.
    providers: sources,
    ingest: runs.map((r) => ({ ...r, ageHours: ageHours(r.finishedAt) })),
    // Surfaced rather than only reporting what succeeded: a job that has been failing all
    // day otherwise looks identical to one that simply has not run.
    failures: failures.map((f) => ({ ...f, ageHours: ageHours(f.at) })),
  });
}

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

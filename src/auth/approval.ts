import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";

/**
 * Owner-only approval page.
 *
 * Claude.ai custom connectors support authless servers or OAuth 2.1 with Dynamic Client
 * Registration; they cannot send a custom auth header (SPEC section 2.9). So the server
 * speaks real OAuth, but the only credential is a single shared password held in a
 * secret. There is exactly one user.
 */

const OWNER_SUBJECT = "owner";

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fantasy Intelligence</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 22rem; margin: 12vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  p { color: #666; margin-top: 0; }
  form { display: flex; flex-direction: column; gap: .75rem; margin-top: 1.5rem; }
  input, button { font: inherit; padding: .6rem .7rem; border-radius: .4rem; border: 1px solid #8886; }
  button { background: #2563eb; color: #fff; border: 0; font-weight: 600; cursor: pointer; }
  .err { color: #b91c1c; font-weight: 600; }
</style></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export function renderApproval(req: AuthRequest, clientName: string, error?: string): Response {
  const state = btoa(JSON.stringify(req));
  return page(
    `<h1>Fantasy Intelligence</h1>
     <p>${escapeHtml(clientName)} is asking to connect.</p>
     ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
     <form method="post">
       <input type="hidden" name="req" value="${state}">
       <input type="password" name="password" placeholder="Owner password"
              autocomplete="current-password" autofocus required>
       <button type="submit">Approve</button>
     </form>`,
    error ? 401 : 200,
  );
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * Constant-time comparison so a wrong password cannot be recovered by timing the
 * response. Length is allowed to leak, which is not useful to an attacker here.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    const authReq = await oauth.parseAuthRequest(request);
    const client = await oauth.lookupClient(authReq.clientId);
    return renderApproval(authReq, client?.clientName ?? authReq.clientId);
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await request.formData();
  const encoded = String(form.get("req") ?? "");
  const password = String(form.get("password") ?? "");

  let authReq: AuthRequest;
  try {
    authReq = JSON.parse(atob(encoded)) as AuthRequest;
  } catch {
    return page("<h1>Invalid request</h1><p>Start the connection again.</p>", 400);
  }

  const expected = env.OWNER_PASSWORD;
  if (!expected) {
    return page(
      "<h1>Not configured</h1><p>OWNER_PASSWORD is not set on this Worker. " +
        "Run <code>wrangler secret put OWNER_PASSWORD</code>.</p>",
      500,
    );
  }
  if (!timingSafeEqual(password, expected)) {
    const client = await oauth.lookupClient(authReq.clientId);
    return renderApproval(authReq, client?.clientName ?? authReq.clientId, "Incorrect password.");
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: authReq,
    userId: OWNER_SUBJECT,
    metadata: { approvedAt: new Date().toISOString() },
    scope: authReq.scope,
    props: { subject: OWNER_SUBJECT },
  });
  return Response.redirect(redirectTo, 302);
}

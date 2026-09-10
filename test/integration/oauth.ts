import { SELF } from "cloudflare:test";

/**
 * Drives the real OAuth 2.1 + Dynamic Client Registration flow that Claude.ai uses, so
 * integration tests exercise the deployed auth path rather than bypassing it.
 */

const ORIGIN = "https://example.com";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(digest) };
}

export async function registerClient(): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test Client",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Full flow. Returns a bearer token usable against /mcp. */
export async function getAccessToken(password = "test-password"): Promise<string> {
  const clientId = await registerClient();
  const { verifier, challenge } = await pkce();
  const authUrl =
    `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=fantasy%3Aread` +
    `&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;

  const form = await SELF.fetch(authUrl);
  if (!form.ok) throw new Error(`authorize GET failed: ${form.status}`);
  const html = await form.text();
  const encoded = html.match(/name="req" value="([^"]+)"/)?.[1];
  if (!encoded) throw new Error("approval page did not contain the auth request");

  const body = new URLSearchParams({ req: encoded, password });
  const approved = await SELF.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  if (approved.status !== 302) {
    throw new Error(`approval failed: ${approved.status} ${(await approved.text()).slice(0, 200)}`);
  }
  const code = new URL(approved.headers.get("location") as string).searchParams.get("code");
  if (!code) throw new Error("no authorization code in redirect");

  const tokenRes = await SELF.fetch(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

/** Attempt approval with the wrong password; returns the HTTP status. */
export async function approvalStatusFor(password: string): Promise<number> {
  const clientId = await registerClient();
  const { challenge } = await pkce();
  const authUrl =
    `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=fantasy%3Aread` +
    `&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;
  const html = await (await SELF.fetch(authUrl)).text();
  const encoded = html.match(/name="req" value="([^"]+)"/)?.[1] as string;
  const res = await SELF.fetch(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ req: encoded, password }),
    redirect: "manual",
  });
  return res.status;
}

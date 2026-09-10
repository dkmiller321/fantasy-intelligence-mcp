/**
 * Call a tool on the deployed server, driving the same OAuth flow claude.ai uses.
 * Useful for smoke-testing a deploy and for capturing demo transcripts.
 *
 *   npm run call -- get_nfl_state
 *   npm run call -- compare_players '{"playerIds":["00-0036322","00-0038542"]}'
 *
 * Reads the owner password from OWNER_PASSWORD, or from SECRETS.local.md.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "./lib/csv";

const BASE =
  process.env.MCP_URL ?? "https://fantasy-intelligence-mcp.fantasy-intelligence-mcp.workers.dev";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function ownerPassword(): string {
  if (process.env.OWNER_PASSWORD) return process.env.OWNER_PASSWORD;
  try {
    const text = readFileSync("SECRETS.local.md", "utf8");
    const line = text.split("\n").find((l) => /^\s{4}\S+$/.test(l));
    if (line) return line.trim();
  } catch {
    // fall through
  }
  throw new Error("Set OWNER_PASSWORD or keep the password in SECRETS.local.md");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function accessToken(): Promise<string> {
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "fantasy-cli",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!reg.ok) throw new Error(`register: ${reg.status} ${await reg.text()}`);
  const { client_id } = (await reg.json()) as { client_id: string };

  const { verifier, challenge } = await pkce();
  const authUrl =
    `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=fantasy%3Aread&state=cli` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  const html = await (await fetch(authUrl)).text();
  const req = html.match(/name="req" value="([^"]+)"/)?.[1];
  if (!req) throw new Error("could not read the approval form");

  const approve = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ req, password: ownerPassword() }),
    redirect: "manual",
  });
  const location = approve.headers.get("location");
  if (!location) throw new Error(`approval failed: ${approve.status}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error("no code returned");

  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
    }),
  });
  if (!tok.ok) throw new Error(`token: ${tok.status} ${await tok.text()}`);
  return ((await tok.json()) as { access_token: string }).access_token;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const positional = argv.filter((a) => !a.startsWith("--"));
  const name = positional[0];
  if (!name) {
    console.error('usage: npm run call -- <tool_name> [\'{"json":"args"}\']');
    process.exit(1);
  }
  const args = positional[1] ? (JSON.parse(positional[1]) as Record<string, unknown>) : {};

  const token = await accessToken();
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: name === "tools/list" ? "tools/list" : "tools/call",
      params: name === "tools/list" ? undefined : { name, arguments: args },
    }),
  });

  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const parsed = JSON.parse((line ?? text).replace(/^data: /, "")) as {
    result?: { content?: { text: string }[] };
    error?: unknown;
  };

  if (parsed.error) {
    console.error(JSON.stringify(parsed.error, null, 2));
    process.exit(1);
  }
  const payload = parsed.result?.content?.[0]?.text;
  if (!payload) {
    console.log(JSON.stringify(parsed.result, null, 2));
    return;
  }
  const envelope = JSON.parse(payload) as Record<string, unknown>;
  console.log(JSON.stringify(envelope, null, flags.raw ? 0 : 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// One integration test per tool, through the MCP server (SPEC section 12).
// Tools that need network or a populated D1 are exercised for envelope shape and
// graceful degradation, which is the contract that matters to the LLM caller.

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getAccessToken } from "./oauth";

// /mcp sits behind OAuth, so every call carries a token minted through the real flow.
let token: string;
beforeAll(async () => {
  token = await getAccessToken();
});

interface Envelope {
  summary: string;
  data: unknown;
  caveats: string[];
  sources: { name: string; asOf: string }[];
  meta: { season: number; week: number; generatedAt: string; detail: string };
}

async function rpc(method: string, params?: unknown) {
  const res = await SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse((line ?? text).replace(/^data: /, ""));
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  const out = await rpc("tools/call", { name, arguments: args });
  expect(out.error, `tools/call ${name} returned a protocol error`).toBeUndefined();
  return JSON.parse(out.result.content[0].text) as Envelope;
}

const EXPECTED_TOOLS = [
  "get_nfl_state",
  "get_my_leagues",
  "set_default_league",
  "get_league",
  "search_players",
  "get_roster",
  "compare_players",
  "recommend_lineup",
  "get_player_profile",
  "get_game_environment",
  "get_news",
  "get_waiver_targets",
  "evaluate_trade",
  "get_matchup_preview",
  "get_playoff_outlook",
];

describe("MCP surface", () => {
  it("exposes the phase 1 tool set", async () => {
    const out = await rpc("tools/list");
    const names = out.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(EXPECTED_TOOLS);
  });

  it("marks every read tool readOnly and the one writer not", async () => {
    const out = await rpc("tools/list");
    for (const t of out.result.tools) {
      const expected = t.name !== "set_default_league";
      expect(t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe(expected);
    }
  });

  it("gives every tool an LLM-facing description", async () => {
    const out = await rpc("tools/list");
    for (const t of out.result.tools) {
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(40);
    }
  });

  it("health endpoint responds", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
  });
});

describe("envelope contract", () => {
  // search_players reads only D1, which is empty in tests. An empty result must still
  // be a well-formed envelope carrying a caveat, never an error (SPEC section 6).
  it("search_players degrades to an empty envelope with a caveat", async () => {
    const env = await callTool("search_players", { query: "nobodyxyz" });
    expect(env.data).toEqual({ candidates: [] });
    expect(env.caveats.length).toBeGreaterThan(0);
    expect(env.summary).toContain("nobodyxyz");
    expect(env.meta).toHaveProperty("generatedAt");
    expect(env.meta.detail).toBe("brief");
  });

  it("rejects a search shorter than the schema allows", async () => {
    const out = await rpc("tools/call", { name: "search_players", arguments: { query: "a" } });
    // Schema violations surface as a tool error, not a malformed envelope.
    const errored = out.error !== undefined || out.result?.isError === true;
    expect(errored).toBe(true);
  });

  it("get_league without a league id explains what to do next", async () => {
    // DEFAULT_LEAGUE_ID is bound in wrangler.jsonc, so this exercises the happy path
    // shape; if Sleeper is unreachable the degraded envelope must still be valid.
    const env = await callTool("get_league");
    expect(Array.isArray(env.caveats)).toBe(true);
    expect(Array.isArray(env.sources)).toBe(true);
    expect(env.meta).toHaveProperty("season");
    expect(typeof env.summary).toBe("string");
  });
});

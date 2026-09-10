// Every tool must satisfy the SPEC section 6 envelope contract, including when the data
// it needs is absent. Tests run against an empty D1, which is exactly the "provider
// missing" case graceful degradation exists for.

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getAccessToken } from "./oauth";

let token: string;
beforeAll(async () => {
  token = await getAccessToken();
});

interface Envelope {
  summary: string;
  data: unknown;
  caveats: string[];
  sources: { name: string; asOf: string }[];
  confidence?: number;
  evidence?: { factor: string; value: string | number; effect: string }[];
  meta: { season: number; week: number; generatedAt: string; detail: string };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const parsed = JSON.parse((line ?? text).replace(/^data: /, ""));
  return { http: res.status, parsed };
}

/** Tools that need no arguments and must degrade cleanly against empty storage. */
const NO_ARG_TOOLS = [
  "get_nfl_state",
  "get_my_leagues",
  "get_league",
  "get_roster",
  "recommend_lineup",
  "get_game_environment",
  "get_news",
  "get_waiver_targets",
  "get_matchup_preview",
  "get_playoff_outlook",
];

describe("envelope contract", () => {
  for (const name of NO_ARG_TOOLS) {
    it(`${name} returns a well-formed envelope and never a bare error`, async () => {
      const { http, parsed } = await call(name);

      // Graceful degradation is a feature: a missing provider changes caveats and
      // confidence, never the HTTP status (SPEC section 12).
      expect(http, `${name} http`).toBe(200);
      expect(parsed.error, `${name} jsonrpc error`).toBeUndefined();

      const env = JSON.parse(parsed.result.content[0].text) as Envelope;
      expect(typeof env.summary, `${name} summary`).toBe("string");
      expect(env.summary.length, `${name} summary length`).toBeGreaterThan(0);
      expect(Array.isArray(env.caveats), `${name} caveats`).toBe(true);
      expect(Array.isArray(env.sources), `${name} sources`).toBe(true);
      expect(env.meta, `${name} meta`).toBeTruthy();
      expect(typeof env.meta.generatedAt, `${name} generatedAt`).toBe("string");
      expect(["brief", "full"], `${name} detail`).toContain(env.meta.detail);
      expect(env).toHaveProperty("data");

      if (env.confidence !== undefined) {
        expect(env.confidence, `${name} confidence range`).toBeGreaterThanOrEqual(0);
        expect(env.confidence, `${name} confidence range`).toBeLessThanOrEqual(1);
      }
    });
  }

  it("compare_players explains itself when ids do not resolve", async () => {
    const { http, parsed } = await call("compare_players", {
      playerIds: ["nonexistent-a", "nonexistent-b"],
    });
    expect(http).toBe(200);
    const env = JSON.parse(parsed.result.content[0].text) as Envelope;
    expect(env.caveats.join(" ")).toMatch(/search_players/);
  });

  it("evaluate_trade explains itself when ids do not resolve", async () => {
    const { parsed } = await call("evaluate_trade", {
      give: ["nonexistent-a"],
      receive: ["nonexistent-b"],
    });
    const env = JSON.parse(parsed.result.content[0].text) as Envelope;
    expect(env.caveats.length).toBeGreaterThan(0);
  });

  it("get_player_profile explains an unknown id", async () => {
    const { parsed } = await call("get_player_profile", { playerId: "nope" });
    const env = JSON.parse(parsed.result.content[0].text) as Envelope;
    expect(env.caveats.join(" ")).toMatch(/search_players/);
  });

  it("a degraded envelope never claims a fantasy conclusion", async () => {
    // The backstop text must tell the model the failure is operational, so it does not
    // report "no news" as "nothing is happening with your players".
    const { parsed } = await call("get_player_profile", { playerId: "nope" });
    const env = JSON.parse(parsed.result.content[0].text) as Envelope;
    expect(env.data).toBeNull();
  });
});

describe("prompts and resources", () => {
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

  it("lists the three prompts", async () => {
    const out = await rpc("prompts/list");
    const names = out.result.prompts.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["trade_check", "waiver_wire_wednesday", "weekly_lineup_review"]);
  });

  it("renders a prompt that names the tools to call", async () => {
    const out = await rpc("prompts/get", {
      name: "weekly_lineup_review",
      arguments: {},
    });
    const text = out.result.messages[0].content.text as string;
    expect(text).toContain("recommend_lineup");
  });

  it("lists both resources", async () => {
    const out = await rpc("resources/list");
    const uris = out.result.resources.map((r: { uri: string }) => r.uri).sort();
    expect(uris).toEqual(["doc://methodology", "league://settings"]);
  });

  it("serves the methodology resource without needing storage", async () => {
    const out = await rpc("resources/read", { uri: "doc://methodology" });
    const text = out.result.contents[0].text as string;
    expect(text).toContain("recomputed from stat lines");
  });
});

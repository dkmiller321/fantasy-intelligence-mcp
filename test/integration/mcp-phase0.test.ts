// One integration test per tool, through the MCP server (SPEC section 12).

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function rpc(method: string, params?: unknown) {
  const res = await SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse((line ?? text).replace(/^data: /, ""));
}

describe("phase 0 MCP surface", () => {
  it("lists both tools with readOnlyHint", async () => {
    const out = await rpc("tools/list");
    const names = out.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["ping", "get_nfl_state"]);
    for (const t of out.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
  });

  it("ping returns ok", async () => {
    const out = await rpc("tools/call", { name: "ping", arguments: {} });
    const payload = JSON.parse(out.result.content[0].text);
    expect(payload.ok).toBe(true);
  });

  it("health endpoint responds", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
  });
});

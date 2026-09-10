import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { approvalStatusFor, getAccessToken, registerClient } from "./oauth";

describe("owner-only OAuth", () => {
  it("refuses /mcp without a token", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses /mcp with a bogus token", async () => {
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts /mcp with a token from the real flow", async () => {
    const token = await getAccessToken();
    const res = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
  });

  it("supports dynamic client registration, which Claude.ai requires", async () => {
    const clientId = await registerClient();
    expect(clientId).toBeTruthy();
  });

  it("rejects the wrong owner password without issuing a code", async () => {
    expect(await approvalStatusFor("wrong-password")).toBe(401);
  });

  it("advertises authorization server metadata", async () => {
    const res = await SELF.fetch("https://example.com/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toContain("/register");
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });

  it("leaves the health endpoint public", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; providers: Record<string, string> };
    expect(body.ok).toBe(true);
    // Optional providers report as absent rather than breaking the endpoint.
    expect(body.providers.odds).toBe("absent");
  });
});

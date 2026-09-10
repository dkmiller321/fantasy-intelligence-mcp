# Phase 0 — prove the pipe

Deployed: `https://fantasy-intelligence-mcp.fantasy-intelligence-mcp.workers.dev/mcp`

## What shipped

Stateless `createMcpHandler` Worker with two tools, `ping` and `get_nfl_state`, authless.
D1 (`fantasy`), KV (`CACHE`, `OAUTH_KV`) and four cron triggers are bound but unused.
CI runs typecheck, lint and tests on every push.

## Real transcript

`tools/call get_nfl_state` against the deployed Worker, verbatim:

```json
{
  "summary": "NFL 2026 is in week 1 of the regular season.",
  "data": {
    "season": 2026,
    "week": 1,
    "seasonType": "regular",
    "seasonStartDate": "2026-09-09",
    "previousSeason": 2025
  },
  "caveats": [],
  "sources": [{ "name": "sleeper", "asOf": "2026-09-10T21:44:58.085Z" }],
  "meta": { "season": 2026, "week": 1, "generatedAt": "2026-09-10T21:44:58.085Z", "detail": "brief" }
}
```

`tools/list` reports both tools with `readOnlyHint: true` and LLM-facing descriptions.

## Deviations

- `McpAgent` is deprecated; built on stateless `createMcpHandler` instead (DECISIONS D2).
- `compatibility_date` pinned to 2026-08-22, the newest the bundled workerd accepts.
  The edge accepts later dates, but local tests must run.
- `@cloudflare/vitest-pool-workers` 0.22 dropped the `./config` subpath in its vitest-4
  migration; config now uses the `cloudflareTest` Vite plugin.

## Not done by me

Adding the connector at claude.ai, and the phone-side confirmation, both require the
owner's Claude account. See RUNBOOK.md.

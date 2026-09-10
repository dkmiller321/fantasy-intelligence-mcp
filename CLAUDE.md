# fantasy-intelligence-mcp

Remote MCP server on Cloudflare Workers that turns the Claude app into a personal
fantasy football analyst for one Sleeper league.

**Current phase: 5 complete — all tools shipped**

## Stack

TypeScript strict, no Python in the Worker. `agents@0.22` (`createMcpHandler`, stateless
— not `McpAgent`, see docs/DECISIONS.md D2), `@modelcontextprotocol/server@2.0`, `zod@4`,
`@cloudflare/workers-oauth-provider`. D1 for storage, KV for provider cache and budget
counters. Biome for lint and format. Vitest with `@cloudflare/vitest-pool-workers`.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | `wrangler dev`, local Worker on :8787 |
| `npm test` | Vitest, unit + integration |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | Biome |
| `npm run deploy` | `wrangler deploy` |
| `npm run db:migrate` / `db:migrate:local` | D1 migrations, remote / local |
| `npm run etl` | nflverse ETL into D1 |
| `npm run fixtures` | Re-record provider fixtures from live APIs |

## Layering

`mcp/`       -> `engine/`, `storage/`, `providers/`, `ids/`, `jobs/`
`engine/`    -> `domain/`, `engine/`, and `ids/`. Pure: no `fetch`, no `env`, no
                `Date.now()`. Time is always a parameter.
`providers/` -> `domain/`, `ids/`. Never `engine/` or `storage/`.
`storage/`   -> `domain/` only.
`ids/`       -> `domain/` only.

`ids/` is a dependency-free leaf of pure normalization (names, teams, positions) that
both the engine and the providers legitimately need, so it is an allowed import for
both rather than duplicated in each. Parsing a provider's wire format belongs in
`providers/`, not in `engine/`: the engine classifies and matches, it does not know
what RSS looks like.

## The league is IDP dynasty

Ten teams, 0.25 PPR, FAAB $200, playoffs start week 14. Eighteen starters:
`QB RB RB WR WR TE FLEX FLEX FLEX REC_FLEX K DL LB DB IDP_FLEX x4`, eleven bench,
twelve taxi. There is no team `DEF` slot. Seven starting slots are individual defensive
players, so IDP is not an edge case here — it is 39% of the lineup.

Points are always recomputed from stat lines against the league's own `scoring_settings`.
Never trust a provider's `pts_ppr`; for IDP it is wrong by more than an order of
magnitude (DECISIONS.md D5).

## Free-plan budget, non-negotiable

10 ms CPU per request, 50 subrequests, 5 cron triggers. Requests read materialized rows
from D1 and do light arithmetic. Anything aggregate is precomputed by cron or the ETL.
If something does not fit, move it to a job — do not propose the paid plan without
numbers.

## Working rules

- Verify, don't recall. Endpoint shapes, release names and feed URLs change. Make a real
  request, save a sanitized fixture under `test/fixtures/<provider>/`, then write the zod
  schema from what actually came back.
- Zod at the edges, domain types inside, no `any`.
- Graceful degradation is a feature: a missing provider adds a caveat and lowers
  confidence, never changes the HTTP status and never throws.
- Simplest correct solution. Three similar lines beat a premature helper. Edit existing
  files before adding new ones.
- Tests assert behavior against hand-computed numbers and recorded fixtures. No test that
  only proves a mock was called.
- Comments explain why. No boilerplate docstrings, no emoji, no TODO stubs, no dead code.
- Every deviation from `docs/SPEC.md` gets an entry in `docs/DECISIONS.md`.

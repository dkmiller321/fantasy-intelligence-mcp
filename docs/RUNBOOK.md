# Runbook

## What you need to do on your return

Three things need your account and cannot be done for you.

### 1. Add the connector at claude.ai

1. Go to claude.ai, Settings, Connectors, "Add custom connector".
2. URL: `https://fantasy-intelligence-mcp.fantasy-intelligence-mcp.workers.dev/mcp`
3. Claude registers itself and sends you to a sign-in page. Enter the owner password
   from `SECRETS.local.md` in the repo root. That file is gitignored.
4. Once added on claude.ai, the connector is available in the iOS and Android apps.
   Mobile cannot add new connectors, only use ones already added on the web.

Ask it: *"Should I start Omarion Hampton or Jaylen Warren this week?"*

### 2. Add the Cloudflare API token to GitHub, so the weekly ETL runs

The wrangler OAuth token on this machine cannot be used by Actions. Create a scoped API
token instead.

1. Cloudflare dashboard, My Profile, API Tokens, Create Token, Custom token.
2. Permissions: `Account / D1 / Edit` and `Account / Workers Scripts / Edit`.
3. In the GitHub repo, Settings, Secrets and variables, Actions, add:
   - `CLOUDFLARE_API_TOKEN` — the token
   - `CLOUDFLARE_ACCOUNT_ID` — `a3414090165dfede2987cc9167405765`

Until that is set, run the ETL locally with `npm run etl -- --remote`.

### 3. Read the owner password

`SECRETS.local.md` in the repo root. Not committed. Rotate with
`wrangler secret put OWNER_PASSWORD`.

## Routine operations

| Task | Command | When |
|---|---|---|
| Weekly stats and schedules | `npm run etl -- --seasons 2025,2026 --remote` | Wednesdays, after nflverse updates |
| Recompute matchup grades | `npm run materialize -- --remote` | After every ETL |
| Refresh projections | `npm run sync:projections -- --remote` | Daily in season |
| Refresh player list and injuries | `npm run sync:players -- --remote` | Daily |
| Rebuild stadium coordinates | `npm run seed:stadiums` | Rarely; only if a team moves |
| Smoke-test a deploy | `npm run call -- get_nfl_state` | After every deploy |
| Check freshness | `curl .../health` | Any time |

The Worker's own cron triggers handle news every 15 minutes and weather every 6 hours.
The heavy jobs are deliberately not on cron; see below.

## Watch out for these

### D1 free tier allows 100,000 row writes per day

A full backfill is about 64,500 writes:

| Load | Rows |
|---|---|
| players | 9,878 |
| player_ids | 36,382 |
| player_week_stats 2025 | 16,520 |
| games | 557 |
| projections, one week | 911 |
| defense_vs_position | 256 |

One backfill per UTC day. Running it twice will hit the limit and jobs will fail with an
explicit quota error. Steady-state usage is roughly 1,200 writes a day, comfortably under.

If you see `exceeded D1's free tier daily row write limit`, wait for midnight UTC. Nothing
is broken.

### Requests get 10 ms of CPU

Free-plan Workers allow 10 ms CPU per request and per cron trigger. That is why
`players/nfl` (14.6 MB) and the nflverse files are Node scripts rather than cron jobs. If
you add a feature that aggregates across many rows, materialize it in a script and have
the request read the result.

### The projections endpoint is undocumented

`api.sleeper.app/projections/nfl/{season}/{week}` is not a documented Sleeper API. It is
isolated in `src/providers/sleeper/projections.ts`. If it disappears, projections fall back
to trailing averages, confidence drops, and every response says so. Nothing crashes.

## Diagnosing a bad answer

1. `curl .../health` — check `freshness` and `ingest`. Stale data explains most oddities.
2. `npm run call -- get_player_profile '{"playerId":"..."}'` — the `evidence` array shows
   every multiplier applied.
3. Check `caveats`. Early-season answers say when matchup grades come from last year.
4. `npx wrangler tail` — one JSON line per request with path, subject, status and ms.

## Recovering from a bad load

Data is idempotent; every write is an upsert on natural keys. Re-running any sync is safe.
To start a table clean:

```
npx wrangler d1 execute fantasy --remote --command "DELETE FROM projections WHERE season=2026 AND week='1'"
npm run sync:projections -- --week 1 --remote
```

Mind the daily write limit before re-running a large load.

## Measured latency

Against the deployed Worker, median of three runs each, token reused so the OAuth
handshake is excluded:

| Tool | Median | Payload |
|---|---|---|
| `get_game_environment` | 299 ms | 4.5 KB |
| `get_nfl_state` | 422 ms | 0.5 KB |
| `get_roster` | 434 ms | 10.6 KB |
| `search_players` | 439 ms | 1.3 KB |
| `compare_players` | 442 ms | 2.0 KB |
| `recommend_lineup` | 495 ms | 5.7 KB |
| `get_playoff_outlook` | 544 ms | 3.9 KB |
| `get_waiver_targets` | 579 ms | 4.1 KB |
| `get_matchup_preview` | 599 ms | 1.6 KB |

Two things this confirms. The SPEC's definition of done asks for an answer in under about
ten seconds; the slowest tool is under six tenths of one. And no request has ever hit the
free plan's 10 ms CPU ceiling, because the aggregates were computed in advance and the
request path only reads rows and multiplies a handful of numbers.

`get_roster` at 10.6 KB is the largest payload; it returns `detail: "full"` by design
because a roster listing is inherently a list. The brief single-player answers are 0.5 to
2 KB, within the SPEC's 2 KB guidance.

If a future change pushes a tool past a second, the cause is almost certainly a new
aggregate being computed in the request rather than materialized. Move it to
`scripts/materialize.ts`.

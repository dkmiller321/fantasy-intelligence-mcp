# Decisions

Each entry: what changed from `docs/SPEC.md`, why, and what it costs.

## D1 — Diagram corrections applied
All fourteen rows of SPEC section 3 are adopted as written: Player is the hub, `Game`
is a first-class entity, `canonicalId` + `externalIds`, structured scoring, `playerIds[]`
on Recommendation, `season`/`scoringFormat`/`asOf` on Projection, `impact` enum on
NewsItem, `get_news(since)` in place of push alerts, adapter + fallback for FantasyPros,
Sleeper + RSS in place of NewsAPI, Open-Meteo in place of OpenWeather, nflverse as a
weekly ETL rather than an API, TypeScript only, `workers-oauth-provider`, and cron
ingestion in place of request-time fan-out.

## D2 — `McpAgent` is deprecated; use stateless `createMcpHandler`
SPEC Phase 0 proposes the `remote-mcp-authless` template, which builds on `McpAgent` and
Durable Objects. Cloudflare's current docs mark that path deprecated and direct new
servers to `createMcpHandler()` from `agents/mcp/server`, which is stateless and creates
one MCP server per request. Taken, which is the SPEC's own stated fallback. It also moots
the question of Durable Object availability on the free plan, since none are used.
Stack: `agents@0.22`, `@modelcontextprotocol/server@2.0` (SDK v2), `zod@4`.
Scaffolded by hand rather than from the template, because the template ships the
deprecated path and more surface than this project needs.

## D3 — Free-plan limits are 10 ms CPU per request, 50 subrequests, 5 cron triggers
Measured against Cloudflare's limits page. Consequences, which are binding on all later
phases:
- The request path may do D1 reads and light arithmetic only. Every aggregate
  (defense-vs-position, usage trends, blended baselines) is materialized by cron or by
  the GitHub Actions ETL and read back as rows.
- Four cron triggers fit under the cap of five, so a single `scheduled()` dispatcher
  keyed on the cron string is used but not strictly required.
- This is the SPEC section 9 "CPU budget rule" resolved in advance rather than after
  measurement: nothing heavy is attempted in a request in the first place.

## D4 — The league is IDP dynasty, which the SPEC data model cannot represent
League `1340893699625717760` ("Franchise Player") has roster positions
`QB, RB, RB, WR, WR, TE, FLEX x3, REC_FLEX, K, DL, LB, DB, IDP_FLEX x4, BN x11`.
Seven of eighteen starting slots are individual defensive players and there is no team
`DEF` slot at all. SPEC section 4 types `Player.position` as
`"QB" | "RB" | "WR" | "TE" | "K" | "DEF"`, which cannot express this league.

Changes:
- `Player.position` extends to `QB | RB | WR | TE | K | DEF | DL | LB | DB`, with raw NFL
  positions (DE, DT, NT, OLB, ILB, MLB, CB, S, FS, SS) normalized into the DL/LB/DB
  buckets Sleeper uses for slot eligibility.
- Slot eligibility is a table covering `FLEX`, `REC_FLEX`, `IDP_FLEX` and `SUPER_FLEX`
  rather than a fixed offensive assumption.
- Scoring computation must handle all 68 of this league's scoring keys, 19 of them IDP.

## D5 — Points are recomputed from stat lines, never read from the provider
Sleeper's projections endpoint returns a `pts_ppr` field alongside a stat line. For IDP
players that field is meaningless: a projected LB stat line of 1.32 solo tackles, 1.83
assists, 0.15 sacks, 0.15 passes defended and 0.31 tackles for loss scores 3.30 points
under this league's map, while Sleeper reports `pts_ppr` as 0.15 — a factor of 22.
Therefore the engine always recomputes points from the stat line against the league's
own `scoring_settings`, and falls back to a provider points field only when no stat line
exists, with a caveat. SPEC section 8 allows either; here recomputation is mandatory.

## D6 — Sleeper's undocumented projections endpoint is live and is the primary source
`GET https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular&position[]=X`
returns 200 with per-player stat lines attributed to `rotowire`, including IDP stats.
No key is required. It remains undocumented and unsupported, so it is isolated in
`providers/sleeper/projections.ts` behind the same interface as FantasyPros; if it
disappears the engine degrades to trailing averages rather than failing.
Being single-source, confidence is capped at 0.7 per SPEC section 8.

## D7 — Early-season blend of prior-season data
The 2026 season is at week 1, so the rolling six-week defense-vs-position window and the
"last 3 weeks vs prior 3" usage trend have no data until roughly week 7. Both are seeded
from 2025 and decayed as 2026 weeks land: full prior-season weight at week 1, roughly
even at week 4, pure current-season from week 7. The weight curve lives in
`engine/config.ts` and every affected response carries a caveat naming the blend.
Not addressed by the SPEC at all.

## D8 — Dynasty trades use an age curve; rookie picks stay out of scope
SPEC section 13 excludes dynasty valuation, but the league is dynasty with a twelve-man
taxi squad, and pure rest-of-season valuation systematically undervalues young players.
`evaluate_trade` keeps replacement-level ROS value as its core and applies a positional
age adjustment. Rookie draft picks are not valued; a trade containing one returns a
caveat saying so. No keyless, ToS-clean source of dynasty pick values exists, and
hand-authoring one from memory would violate the SPEC's "verify, don't recall" rule.

## D9 — IDP gets full analytical parity with offense
`stats_player_week_{season}.csv` in the nflverse `stats_player` release carries
`def_tackles_solo`, `def_tackle_assists`, `def_tackles_for_loss`, `def_fumbles_forced`,
`def_sacks`, `def_qb_hits`, `def_interceptions`, `def_pass_defended`, `def_tds` and
`def_safeties` in the same rows as offensive stats. These cover all nineteen IDP scoring
keys, so IDP history, usage trends and matchup factors come from the existing ETL pass
rather than a second pipeline. Where projection coverage is thin — 134 of 1252 LBs had
real stat lines in week 1 — the engine falls back to the player's trailing average,
lowers confidence and names the affected slots in `caveats`.

## D10 — nflverse release layout was reorganized; use `stats_player`
The SPEC references `player_stats`, `snap_counts` and `ff_opportunity` as separate
sources. The current `nflverse-data` releases expose a consolidated `stats_player`
release with `stats_player_week_{season}.csv` covering offense and defense together.
`snap_counts`, `injuries`, `depth_charts`, `schedules` and `players` remain separate
releases. Verified against the GitHub releases API rather than recalled.

## D11 — npm installs use `legacy-peer-deps`
The `agents` package declares peer dependencies on React, Vite and several AI SDKs that
this Worker does not use, and npm's resolver both errored and hit an internal
`edgesOut` crash on a clean tree. `.npmrc` sets `legacy-peer-deps=true` so local and CI
installs agree. No runtime effect; none of those peers are imported.

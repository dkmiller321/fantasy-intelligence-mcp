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

## D12 — Canonical ids need the dynastyprocess crosswalk, not just Sleeper
SPEC section 4 defines `canonicalId` as "gsis_id when present, else `slp_<sleeperId>`".
Measured against the live league that rule fails badly: Sleeper populates `gsis_id` for
only 405 of 1953 active players, and 343 of the 421 players rostered in this league lack
it, so 81% of the league would be unable to join to nflverse stats — the exact silent
failure SPEC section 2.6 calls the number-one risk.

Adding the dynastyprocess `db_playerids.csv` crosswalk (12,492 sleeper_id/gsis_id pairs,
keyless, from the source SPEC section 5 already lists as `ff_playerids`) recovers 330 of
those 343. Unresolved falls to 13 players, or 3.1%, and every one is a 2026 rookie with
no prior-season stats to join to. Resolution order is Sleeper's own `gsis_id` first as
first-party data, then the crosswalk, then `slp_<sleeperId>` as a marked-unresolved
fallback. `isUnresolved()` lets tools add a caveat rather than silently returning nothing.

## D13 — All heavy ingestion runs in GitHub Actions, not in Worker crons
The free plan allows 10 ms CPU per Cron Trigger, the same ceiling as an HTTP request.
Sleeper's `players/nfl` payload is 14.6 MB and 12,227 players; parsing it costs far more
than 10 ms of CPU, so it cannot run inside the Worker at all. SPEC section 9's CPU budget
rule resolves this in favour of the GitHub Actions path rather than Workers Paid.

Split:
- GitHub Actions / local Node scripts: `players/nfl` sync, nflverse weekly stats, the id
  crosswalk, and the weekly recompute of `defense_vs_position` and `usage_trends`.
- Worker crons, all small payloads: RSS headlines, odds, and Sleeper trending adds.

Consequence: injury status is as fresh as the last players sync rather than 15 minutes.
RSS remains the fast path for breaking news, and `get_news` reports both timestamps so
the staleness is visible rather than assumed.

## D14 — The Odds API is not needed; nflverse schedules already carry the lines
SPEC section 5 budgets The Odds API at roughly 240 of its 500 free monthly credits for
spreads and totals, and SPEC section 3 treats game environment as a first-class signal
that needs a key. It does not: the nflverse `schedules/games.csv` release carries
`spread_line` and `total_line` per game, alongside `roof`, `surface`, `stadium_id`,
and post-game `temp`/`wind`. All 16 week-1 games of 2026 had both a spread and a total,
and 101 of 272 games across the season were already lined.

Implied team totals are therefore computed from data the ETL already downloads, with no
key, no credit budget and no third-party account. The Odds API adapter is not built.
If a live in-week line ever matters more than the opening number, it can be added behind
`ODDS_API_KEY` without changing the engine, which reads `games.implied_home` /
`implied_away` regardless of who wrote them.

Weather is the one genuinely missing piece, because nflverse's `temp` and `wind` are
post-game observations rather than forecasts. Open-Meteo supplies the forecast, keyless,
and accepts every stadium in a single request.

## D15 — D1's free tier allows 100,000 row writes per day, which the backfill exceeds
Loading the initial dataset costs roughly:

| Load | Rows |
|---|---|
| players | 9,878 |
| player_ids | 36,382 |
| player_week_stats 2025 | 16,520 |
| games (2025 + 2026) | 557 |
| projections, one week | 911 |
| defense_vs_position | 256 |

A single clean backfill is about 64,500 writes and fits. Running it twice in one day does
not, and the first load had to be repeated after the "NA" defect was found, which
exhausted the day's quota and made the weather job fail with an explicit limit error.

This is a one-time shape, not an ongoing one. Steady-state writes are the daily
projections refresh plus the weekly recompute and forecasts, roughly 1,200 rows a day
against a 100,000 ceiling. Backfills should be run once, and no more than one per UTC
day; `RUNBOOK.md` says so. Per SPEC section 2.10 this is not a reason to buy the paid
plan, and no paid dependency is introduced.

## D16 — Tool count stays at fifteen; only `ping` is removed
SPEC section 7 lists fifteen tools and asks for consolidation to about twelve "if overlaps
appear in practice". Built and exercised, they do not overlap: each maps to a distinct
question an owner actually asks, which is SPEC section 2.2's test. Folding `get_league`
into `get_my_leagues` would make the common case (one league, full settings) return a
list wrapper, and folding `get_nfl_state` into a resource would remove the cheapest way
for the model to learn the current week before every other call.

`ping` is removed. It was a Phase 0 scaffold that proved the transport, and it tells the
model nothing that `get_nfl_state` does not while occupying a slot in every tool listing.
`/health` covers the operational check it was serving.

Final surface: fifteen tools, three prompts (`weekly_lineup_review`,
`waiver_wire_wednesday`, `trade_check`), and two resources (`league://settings`,
`doc://methodology`).

## D17 — Value is ranked within a position, and read tools must not write
Three defects found by running the finished tools against the real league rather than
against tests. All three produced confident, plausible, wrong answers, which is the
failure mode worth guarding hardest against.

**Read tools were writing on every call.** `syncLeague` upserted the league and all ten
teams on every request, so tools annotated `readOnlyHint: true` performed eleven writes
per read. It wasted the free tier's daily write budget and, once that ran out, made every
read fail. `syncLeague` now serves from D1 while the stored copy is under five minutes
old, and a failed write no longer fails the read: the fetched data is already correct and
persisting it is only an optimization for the next caller.

**Waiver targets were ranked by raw projection**, which returned six quarterbacks, because
quarterbacks score most. Useless advice to an owner who starts one and already rosters
four. Candidates are now scored by how much they would improve *this* lineup: the
projection minus the weakest starter they are eligible to displace. The same query now
returns linebackers, kickers and a defensive back, which are the slots this roster is
actually thin at, with correspondingly modest bids.

**Replacement level was zero for every position except quarterback.** The free-agent pool
was selected with `ORDER BY points DESC LIMIT 250`, which in practice returns almost
nothing but quarterbacks, so no other position had a replacement baseline and every
player at those positions was valued at their full projection. It made a 23-year-old
running back look worth six times a streamable quarterback for the wrong reason. The pool
is now ranked within each position with a window function, and a position with no
meaningful free agents falls back to an explicit floor rather than to zero.

The lesson generalizes: any "top N" over a mixed-position pool is really a quarterback
filter, and any cross-position comparison has to be made in units of value over
replacement.

## D18 — The FantasyPros adapter is not written, because it cannot be verified
The plan was to write the FantasyPros and Odds adapters with fixtures and tests but leave
them dark behind key checks. The Odds adapter turned out to be unnecessary (D14). The
FantasyPros adapter is genuinely blocked: its partner API requires an approved key, and
SPEC section 5 is explicit that an adapter must be written from a recorded real response,
never from remembered field names. Without a key there is no response to record, so any
adapter written now would be a guess wearing tests.

What exists instead is the seam. `src/providers/sleeper/projections.ts` implements the
projection source behind a small interface, `CONFIG.sourceWeights` already carries
`fantasypros: 0.6`, and `consensusProjection` blends any number of sources. Adding
FantasyPros later means recording fixtures and writing one file; nothing else changes,
and confidence stops being capped at 0.7 automatically once a second source appears.

## D19 — Worker crons carry only the two jobs that fit
The cron table listed four triggers, two of which (`projections`, `recompute`) were
placeholders returning zero. Left in place they would have looked scheduled while doing
nothing every night. They now run in `.github/workflows/daily.yml` alongside the player
sync, with a `concurrency` group so two runs cannot race and exhaust D1's daily write
allowance. The Worker keeps only news and weather, whose payloads genuinely fit.

## D20 — ESPN is the second projection source, and it does not cover IDP
SPEC section 8 caps confidence at 0.7 on a single source, which every recommendation was
hitting because Sleeper was the only projection provider. FantasyPros remains unobtainable
without an approved key (D18), but ESPN's public fantasy API turns out to serve projections
keyless, and it returns a raw stat line rather than only a points total.

Verified rather than assumed. ESPN keys stats by opaque numeric id, so the mapping was
derived by reconstructing totals ESPN itself publishes:

| Player, week 1 2026 | Reconstructed | ESPN reports |
|---|---|---|
| Amon-Ra St. Brown | 18.84 | 18.83 |
| Josh Allen | 19.53 | 19.32 |

Both land inside ESPN's own rounding, which is the evidence the ids are right. Points are
then recomputed against this league's 68 keys, exactly as for Sleeper, so `appliedTotal`
is never trusted.

Two limits, both reported rather than hidden:

- **No IDP.** A request filtered to defensive slots returns HTTP 400: ESPN's public default
  league has no such slots. Seven of eighteen starting slots therefore stay single-source,
  and `evaluationCaveats` now names the affected players instead of describing the whole
  roster as single- or multi-source.
- **Id matching needed the crosswalk.** Sleeper's own `espn_id` matched only 125 of 511
  projections, 24%. The dynastyprocess crosswalk carries `espn_id` too and matches 94%;
  the remainder are team D/ST, which this league does not roster. `sync-players` now loads
  both sets of ids.

Weights: FantasyPros 0.6 if ever available, ESPN 0.35, Sleeper 0.35. ESPN and Sleeper are
each one house projection and neither deserves the edge; FantasyPros is a consensus of many
analysts and does. Measured effect on a real comparison: confidence rose from 0.70 to 0.76
and Hampton's projection moved from 17.9 to 19.3 as the two sources blended.

ESPN is undocumented and unsupported, the same risk Sleeper's projections endpoint carries.
It is isolated in `src/providers/espn/projections.ts`, reads only the public default league,
and its loss costs the confidence lift and nothing else.

## D21 — Depth charts and snap counts replace two proxies
Two engine inputs were standing in for data that exists and is free.

**Waiver opportunity** used Sleeper's `depth_chart_order`, which is coarse and often
stale. nflverse publishes the teams' own depth charts keyed by `gsis_id`, so no name
matching is involved. The 2026 file is 46 MB across 509,781 rows because it is a time
series with several snapshots a day; only the newest row per player and position is kept,
which distils to 4,162 current entries. A published rank of 1 now scores 1.0 for
opportunity, rank 2 scores 0.5 because one injury promotes them, and the rest 0.15.

**Usage trends had no snap data at all**, which mattered most for IDP: a defender's
scoring is very nearly a function of how many snaps they are on the field for, and the
weekly stats release does not carry snaps. `snap_counts` does, including `defense_pct`.
It keys on Pro Football Reference ids, joined through the dynastyprocess crosswalk.

Coverage is best exactly where it was most needed: of 2025 stat rows, DL 99%, DB 90%,
LB 85%. 14,844 rows now carry snap counts.

Materialized against a complete 2025 season the signal is the one worth having — the
largest risers are players going from a bit part to every down:

| Player | Snap share before | After |
|---|---|---|
| Justin Reid, DB | 0.03 | 0.99 |
| Joe Andreessen, LB | 0.04 | 1.00 |
| Kelee Ringo, DB | 0.07 | 1.00 |

That is a starting job changing hands, which is the most actionable waiver signal an IDP
league has, and it was previously invisible.

Two regressions were caught while wiring this up. Adding a second projection source made
the projections join return one row per source, so the same free agent appeared twice in
the waiver list and the replacement-level pool double-counted; both queries now group by
player. Usage trends still compute nothing in week 1, because two three-week windows do
not exist yet — that is correct, not broken.

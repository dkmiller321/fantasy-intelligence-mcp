# Fantasy Intelligence MCP — Build Spec and Claude Code Prompt

**How to use this file**

1. Fill in the `Inputs` block below.
2. Create an empty directory, open Claude Code in it, and paste this entire file as your first message.
3. Claude Code's first action is to save the message verbatim as `docs/SPEC.md`. Drop the architecture PNG at `docs/architecture.png` when you can (Claude Code can read images).
4. If the `no-ai-slop` skill is available in your Claude Code setup, load it at session start; Section 12 restates its rules for this project.

---

## Inputs (fill in before pasting)

```
SLEEPER_USERNAME:     kMills321
SLEEPER_LEAGUE_IDS:   ___              # 2026 season; comma-separated if several
PRIMARY_CLIENT:       Claude app (iOS/Android)   # or: ChatGPT / both
CLOUDFLARE_PLAN:      Workers Free     # or: Workers Paid
API_KEYS_I_HAVE:      none             # any of: fantasypros, the-odds-api, openweather, newsapi
GITHUB_REPO:          use the connected mcp to create one    # for CI and the weekly nflverse ETL job
LEAGUE_FORMAT:        dynasty
```

Nothing in Phases 0–1 needs an API key.

---

## 1. Mission

Build a remote MCP server on Cloudflare Workers that turns the Claude app (and optionally ChatGPT) into my personal fantasy football analyst. The end goal, verbatim from the design: *"Given your league, your roster, and the current NFL environment, what move gives you the best chance to win?"*

The eight outputs the server must enable: start/sit advice, waiver-wire recommendations, trade evaluation, roster optimization, player intelligence, matchup analysis, playoff planning, and injury/news awareness.

`docs/architecture.png` is the source of intent. Where this spec differs from the diagram, this spec wins (Section 3 lists every difference and why).

## 2. Architecture decisions (fixed — ask before relitigating)

1. **The server never calls an LLM.** All "intelligence" is deterministic, testable math. The client LLM (Claude/ChatGPT) does the reasoning and the prose. This keeps cost at zero, makes every recommendation reproducible, and keeps the engine unit-testable.
2. **Tools map to user decisions, not to data providers.** A start/sit question should need one tool call, not five. Every tool returns everything the LLM needs (projection, matchup, environment, injury, news) in one round trip. Fewer, coarser tools — about a dozen.
3. **One Worker, layered by folder.** The diagram's "MCP Server" and "Application Layer" are one deployable. Keep the logical layering (`mcp/` → `engine/` → `providers/` + `storage/`) as import discipline, not as separate services.
4. **TypeScript only, strict mode.** No Python in the Worker. The nflverse ETL is a Node script run by GitHub Actions.
5. **Provider adapters behind one interface**, with fixtures recorded from real responses. Any provider can be missing; tools degrade gracefully and say so in `caveats`.
6. **Canonical player ID + crosswalk is foundational** (Phase 1, before any analytics). Every provider keys players differently; unresolved joins are the number-one silent-failure mode in fantasy data.
7. **Ingest on cron, serve from storage.** Tool calls read D1/KV; they do not fan out to six APIs at request time (mobile latency, free-tier subrequest and CPU limits). Only cheap, league-specific Sleeper calls happen inline, behind short KV TTLs.
8. **Uniform response envelope** (Section 6) on every tool. Data freshness and source attribution are first-class fields, not afterthoughts.
9. **Auth = Cloudflare's OAuth provider, owner-only.** Claude.ai custom connectors support authless servers or OAuth 2.1 with Dynamic Client Registration; they do not support custom auth headers. Mobile apps use connectors already added on claude.ai and cannot add new ones. Phase 0 is authless to prove the pipe; OAuth lands before any third-party API key is added.
10. **Free tier by default.** Any paid dependency (Workers Paid, API plans) is a decision you bring to me with numbers, not a default.

## 3. Corrections to the diagram

Apply these; record each as a short entry in `docs/DECISIONS.md`.

| Diagram | Problem | Do this instead |
|---|---|---|
| Data models chained left-to-right with `1..*` (Player → Projection → Matchup → NewsItem → Recommendation → UserLeague) | Cardinalities are wrong; a Projection doesn't own Matchups | Player is the hub: Player 1..* Projection, Player 1..* PlayerWeekStats, Player 0..* NewsItem. Recommendation → 1..* Player and → 1 League. See Section 4 |
| No home for odds, kickoff, roof, or weather (`Matchup.weather: string`) | Game environment is a first-class signal | Add a `Game` entity; matchup data references `gameId` |
| `Player` has a single `id` | Cross-provider joins are impossible | `canonicalId` + `externalIds` map; crosswalk table from nflverse `ff_playerids` plus Sleeper's cross-IDs |
| `UserLeague.scoringSettings: string` | Scoring drives every projection | Structured scoring map (Sleeper `scoring_settings`) + roster slots + playoff weeks + waiver/FAAB settings. Split into `League` and `Team` |
| `Recommendation.playerId` (single), `type: string` | Trades involve multiple players | `playerIds[]`, `type` enum, `leagueId`, `week`, `evidence[]` |
| `Projection` lacks season and scoring format | Ambiguous across years and formats | Add `season`, `scoringFormat` (or stat-line fields), `asOf` |
| `NewsItem.impact: string` | Unfilterable | `impact` enum (high/medium/low), `playerIds[]`, `url`, dedupe key |
| "Real-time injury/news alerts" | MCP is request/response; the server cannot push to the client | `get_news(since=…)` is the "what changed" feed. Push channels (Discord/email via cron) are out of scope for v1 |
| FantasyPros listed as free | Partner API requires an approved key; may be denied | Adapter + fallback (Section 5). Never scrape HTML from sites whose ToS forbid it |
| NewsAPI as breaking-news source | Free tier is delayed and dev-only | Sleeper injury fields (authoritative, near-real-time) + 2–3 RSS feeds. NewsAPI optional |
| OpenWeather | Needs a key | Open-Meteo (keyless, hourly forecasts) as primary; OpenWeather optional |
| nflverse as an "API" | It's versioned data files on GitHub releases | Weekly ETL job → D1. Never parsed inside a request |
| Tech stack "Python/TypeScript" | Two toolchains, no benefit | TypeScript. Node script for ETL |
| "Authentication" unspecified | Client constraints are specific | `@cloudflare/workers-oauth-provider`, owner-only login page |
| "Fetch data (APIs in parallel)" at request time | Blows free-tier limits, slow on mobile | Cron ingestion; requests read storage |

## 4. Data model (v1)

Domain types live in `src/domain/`. D1 tables mirror them; migrations in `migrations/`.

```ts
Player {
  canonicalId: string          // ours. gsis_id when present, else "slp_<sleeperId>"
  externalIds: { sleeper?: string; gsis?: string; espn?: string; fantasypros?: string; pfr?: string; yahoo?: string }
  name: string
  position: "QB" | "RB" | "WR" | "TE" | "K" | "DEF"
  team: string | null          // NFL abbreviation, nflverse convention
  status: "active" | "inactive" | "practice_squad" | "free_agent"
  injury: { status: "healthy" | "questionable" | "doubtful" | "out" | "ir" | "pup" | "suspended"; bodyPart?: string; note?: string; updatedAt?: string }
  byeWeek: number | null
  depthChartOrder?: number
  updatedAt: string
}

League {
  id: string; platform: "sleeper"; season: number; name: string
  scoring: Record<string, number>     // Sleeper scoring_settings, keys verbatim
  rosterPositions: string[]           // e.g. ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF","BN",...]
  numTeams: number; playoffWeekStart: number; playoffTeams: number
  waiverType: "faab" | "rolling" | "reverse_standings"; faabBudget?: number
  myTeamId: string                    // the owner's roster_id
}

Team {
  leagueId: string; teamId: string; ownerUserId: string; displayName: string
  playerIds: string[]; starters: string[]; faabRemaining?: number
  record: { w: number; l: number; t: number; pointsFor: number }
}

Game {
  id: string; season: number; week: number; kickoff: string
  home: string; away: string
  roof: "outdoors" | "dome" | "closed" | "open"; surface?: string
  venue: { name: string; lat: number; lng: number }
  odds?: { spread: number; total: number; impliedHome: number; impliedAway: number; asOf: string }  // spread from the home team's perspective
  weather?: { tempF: number; windMph: number; precipProb: number; asOf: string }                      // outdoor games only
}

Projection {
  playerId: string; season: number; week: number | "ros"; source: string
  scoringFormat: "ppr" | "half" | "std" | "league"
  points: number; floor?: number; ceiling?: number
  statLine?: Record<string, number>; asOf: string
}

PlayerWeekStats {
  playerId: string; season: number; week: number; opponent: string
  fantasyPointsPpr: number
  snaps?: number; snapShare?: number; targets?: number; targetShare?: number
  carries?: number; redZoneTouches?: number; routes?: number
}

DefenseVsPosition { team: string; season: number; throughWeek: number; position: string; fpaPerGame: number; rank: number; window: number }  // materialized weekly

NewsItem {
  id: string; dedupeKey: string; playerIds: string[]; source: string
  title: string; summary?: string; url?: string
  impact: "high" | "medium" | "low"; publishedAt: string; fetchedAt: string
}

Recommendation {   // logged so accuracy can be reviewed after the season
  id: string; type: "start_sit" | "lineup" | "waiver" | "trade" | "playoff"
  leagueId: string; week: number; playerIds: string[]
  verdict: string; confidence: number; evidence: Evidence[]; createdAt: string
}

UserPrefs { subject: string; defaultLeagueId?: string; sleeperUsername: string }
```

## 5. Providers

Every adapter implements a small interface in `src/providers/types.ts` (`name`, typed fetch methods, `health()`), parses responses with zod, and has recorded fixtures under `test/fixtures/<provider>/`. Shared `src/providers/http.ts`: timeout, one retry with backoff on 5xx/429, ETag support, and a per-provider monthly budget counter in KV so a bug can't burn a free quota.

| Source | What we take | Auth | Cache / TTL | Risk and notes |
|---|---|---|---|---|
| **Sleeper** (`api.sleeper.app/v1`) | user → leagues; league settings; rosters; users; `matchups/{week}`; transactions; `state/nfl` (season/week); `players/nfl` (injury fields + cross-IDs); `players/nfl/trending/add` | none | league/rosters/matchups 5 min; trending 1 h; `players/nfl` once per day (Sleeper asks for this; the file is several MB) | Public read-only API, ~1000 calls/min limit; stay far under it |
| **nflverse** (GitHub releases) | weekly player stats; snap counts; schedules (`games`: kickoff, roof, surface, possibly `spread_line`/`total_line`); injuries (practice reports); `ff_opportunity` (expected points); `ff_playerids` crosswalk (dynastyprocess) | none | weekly ETL (Tue/Wed) | Files, not an API. Release names and columns were reorganized in 2025 — verify current names before coding. Parsed in GitHub Actions, loaded to D1 |
| **FantasyPros** partner API | ECR rankings, weekly and ROS projections with stat lines, ADP | `x-api-key` (apply; may be denied) | 12 h | If no key: `SleeperProjectionsProvider` (undocumented `projections/nfl/{season}/{week}` endpoint, isolated and documented as a risk) is primary. Single-source consensus caps confidence at 0.7 |
| **The Odds API** | NFL spreads + totals | key; 500 credits/month free | 6 h | Cost = markets × regions per call. One region, two markets, four calls/day ≈ 240 credits/month. Budget counter mandatory. No player props in v1 |
| **Open-Meteo** | hourly temp, wind, precip probability at kickoff | none | 3 h | Only for `roof` = outdoors/open; stadium lat/lng from a committed `stadiums.json` (~30 rows). OpenWeather optional if `OPENWEATHER_KEY` is set |
| **News via RSS** | headlines from 2–3 feeds (ESPN NFL, CBS Sports, NBC/Rotoworld player news — verify current feed URLs) | none | 15 min | Match to players by normalized name + team; classify `impact` with keyword rules; dedupe on normalized title. Sleeper's `injury_status` / `news_updated` is the authoritative status signal |

Rule for every provider: before writing the adapter, make a real request (curl or a tiny script), save the sanitized response as a fixture, and write the zod schema from what actually came back. Never invent fields from memory.

## 6. Tool response envelope

Every tool returns a `text` content block containing exactly this JSON (plus `structuredContent` / `outputSchema` if the SDK version in use supports them):

```ts
type Envelope<T> = {
  summary: string;               // 1–3 plain sentences answering the question; no hedging boilerplate
  data: T;
  evidence?: { factor: string; value: string | number; effect: "+" | "-" | "0"; note?: string }[];
  confidence?: number;           // 0–1; present only on recommendations
  caveats: string[];             // stale data, missing sources, injury uncertainty, single-source projection
  sources: { name: string; asOf: string }[];
  meta: { season: number; week: number; leagueId?: string; generatedAt: string; detail: "brief" | "full" };
}
```

Rules: round numbers (one decimal for points, none for percentages). `detail: "brief"` is the default and a single-player answer must fit in roughly 2 KB; `full` is opt-in. Missing providers never throw — they add a caveat and lower confidence. Never return a bare error to the LLM; return an envelope with empty `data` and a caveat saying what failed and what the user can do.

## 7. MCP surface

Transport: Streamable HTTP at `/mcp` (keep `/sse` only if the template ships it). Tool input schemas in zod. Each tool description is written for an LLM caller: when to use it, what it returns, units, and which other tool to prefer instead. Set `readOnlyHint` on every read tool.

| Tool | Inputs | Returns (`data`) |
|---|---|---|
| `get_nfl_state` | – | season, week, seasonType, per-provider data freshness |
| `get_my_leagues` | – | leagues for the configured Sleeper user; the default league |
| `set_default_league` | leagueId | ack (persisted per OAuth subject) |
| `get_league` | leagueId? | settings (structured scoring, slots, playoff weeks, waiver type), standings, my team |
| `search_players` | query, position? | ≤ 10 candidates with canonicalId, team, position, status |
| `get_player_profile` | playerId, leagueId?, week?, detail? | injury; role/usage trend (last 4 weeks); consensus projection + range; this week's matchup + game environment; recent news; ROS outlook |
| `get_roster` | leagueId?, week? | each rostered player with position, bye, injury, projection, matchup grade; flags where current lineup ≠ optimal |
| `recommend_lineup` | leagueId?, week? | optimal starters per slot with the runner-up and margin, per-decision evidence, flex logic, confidence |
| `compare_players` | playerIds[2..4], leagueId?, week? | side-by-side (projection, range, matchup, environment, injury, news), lean, confidence, evidence |
| `get_waiver_targets` | leagueId?, position?, limit? | available players ranked with "why now" (usage delta, teammate injury, trending adds), ROS value, FAAB band |
| `evaluate_trade` | leagueId?, give[], receive[], counterpartyTeamId? | value-over-replacement delta for both sides, roster fit, playoff-schedule impact, verdict, confidence |
| `get_matchup_preview` | leagueId?, week? | my projected total vs opponent's, win probability, swing players, key game environments |
| `get_game_environment` | week?, team? | per game: kickoff, roof, weather, spread, total, implied totals |
| `get_news` | leagueId? or playerIds[], since?, minImpact? | NewsItems newest-first; with `since` this is the "what changed" feed |
| `get_playoff_outlook` | leagueId? | per rostered player: playoff-week schedule difficulty; team summary; upgrade suggestions |

That is 15. Consolidate to about 12 before Phase 5 if overlaps appear in practice (e.g. fold `get_nfl_state` into a resource, `get_league` into `get_my_leagues`). Add MCP **prompts** in Phase 5 (`weekly_lineup_review`, `waiver_wire_wednesday`, `trade_check`) and **resources** (`league://{id}/settings`, `player://{id}`).

## 8. Engine methodology

Defaults below; all weights live in `src/engine/config.ts` and are documented in `docs/METHODOLOGY.md`. Everything under `src/engine/` is pure: no `fetch`, no `env`, no `Date.now()` (time is a parameter). Each function has unit tests with hand-computed fixtures.

- **Consensus projection**: weighted mean of available sources (FantasyPros 0.6 / Sleeper 0.4 when both; single source → weight 1.0 and confidence capped at 0.7). If stat-line projections exist, recompute points from the league's scoring map; otherwise map by format and add a caveat.
- **Range**: source floor/ceiling if provided; else consensus ± 1σ of the player's last 6 weeks (minimum 3 games, else position-level σ).
- **Matchup**: opponent fantasy points allowed vs position over a rolling 6-week window → z-score → multiplier clamped to [0.85, 1.15].
- **Game environment**: implied team total = total/2 ∓ spread/2 → z-score vs league mean → multiplier clamped to [0.90, 1.10]. Outdoor only: wind ≥ 15 mph → ×0.92 for QB/WR/TE/K; precip probability ≥ 60% → ×0.96. Dome/closed → 1.0.
- **Injury gates**: out/IR/doubtful/suspended → excluded from lineups but still shown; questionable → ×0.90, wider range, and a caveat.
- **Usage trend**: last 3 weeks vs prior 3 for snap share, target/carry share, route rate; label rising/flat/falling with the delta.
- **Composite** = consensus × matchup × environment (× injury). Report each factor's contribution in `evidence` so the LLM can explain, and override with context the server lacks.
- **Confidence** = 0.5 + 0.2·(source agreement) + 0.2·(normalized projection gap between candidates) − 0.15·(injury uncertainty) − 0.10·(missing sources), clamped to [0.05, 0.95].
- **Lineup**: fill fixed slots by composite, then FLEX/SUPERFLEX from the remaining eligible; report the runner-up per slot and the margin.
- **Waivers**: exclude every rostered player in the league; score = 0.5·ROS value + 0.3·usage trend + 0.2·opportunity (teammate injury or depth-chart change), boosted by Sleeper trending adds; FAAB band by score tier (1–3%, 5–10%, 15–25%, 30%+).
- **Trade**: value over replacement per player (ROS points − replacement level at the position, where replacement = best available free agent at that position in this league); weight weeks ≥ `playoffWeekStart` ×1.25; roster-fit adjustment (can they actually start? bye conflicts?); 2-for-1s count the dropped player at replacement level.
- **Playoffs**: for each playoff week, opponent DvP rank percentile; sum per player; flag byes; team summary.
- **Matchup win probability**: each team's total as normal(Σμ, √Σσ²); P(win) from the difference.

## 9. Storage, caching, jobs

- **D1**: `players`, `player_ids`, `leagues`, `teams`, `games`, `projections`, `player_week_stats`, `defense_vs_position`, `news_items`, `recommendations`, `user_prefs`, `ingest_runs` (job, startedAt, finishedAt, status, rowCount, error). Every row carries `fetched_at` / `as_of`.
- **KV**: provider response cache with the TTLs in Section 5, keyed `prov:<provider>:<path>:<hash>`; budget counters `budget:<provider>:<yyyy-mm>`. Free-tier KV has a daily write cap — use the Cache API for sub-hour TTLs and write KV only when the value must be shared across requests.
- **Cron Triggers** (verify the free-plan cap on triggers per Worker; use one `scheduled()` dispatcher keyed on the cron string if needed): every 15 min in-season → RSS + Sleeper injury deltas; every 6 h → odds; daily 09:00 UTC → `players/nfl` + projections; Tuesday 06:00 UTC → recompute `defense_vs_position` and usage trends after the ETL lands.
- **GitHub Actions** (`.github/workflows/nflverse-etl.yml`, weekly + manual): download nflverse files, transform in Node, load to D1 in batches via `wrangler d1 execute --remote` (or the D1 HTTP API).
- **CPU budget rule**: after Phase 1, measure the `players/nfl` sync in deployed logs. If it exceeds the free-plan CPU limit per invocation, move it to the GitHub Actions path (the default) rather than upgrading the plan. Bring me numbers if you think Workers Paid is the better trade.
- Every job is idempotent (upsert on natural keys) and writes an `ingest_runs` row; `/health` reports per-provider freshness from that table.

## 10. Repo layout

```
fantasy-intelligence-mcp/
  CLAUDE.md                 # conventions, commands, current phase (created in Phase 0)
  wrangler.jsonc  package.json  tsconfig.json  biome.json
  src/
    index.ts                # Worker entry: OAuth provider → MCP handler; scheduled() dispatcher
    mcp/                    # server setup, tool registration; tools/<name>.ts = schema + thin handler
    auth/                   # workers-oauth-provider config; owner-only approval page
    providers/              # types.ts, http.ts, sleeper/, nflverse/, fantasypros/, odds/, weather/, news/
    engine/                 # PURE: normalize/, projections, matchup, environment, injuries, usage,
                            #       lineup, compare, waivers, trade, playoffs, confidence, config
    storage/                # d1/ repositories, kv.ts, cache.ts
    ids/                    # canonical id, crosswalk resolution, name normalization
    jobs/                   # cron handlers, one file each, idempotent
    domain/                 # types from Section 4
  migrations/               # numbered D1 SQL
  scripts/                  # nflverse-etl.ts, seed-stadiums.ts, refresh-fixtures.ts
  test/                     # fixtures/<provider>/, unit/, integration/, contract/
  docs/                     # SPEC.md (this file), architecture.png, METHODOLOGY.md, DECISIONS.md, RUNBOOK.md, demos/
  .github/workflows/        # ci.yml, nflverse-etl.yml
```

Import discipline: `mcp/` may import `engine/`, `storage/`, `providers/`; `engine/` imports only `domain/` and `engine/`; `providers/` never import `engine/`. Enforce with a lint rule if cheap, otherwise by review.

## 11. Phases

Each phase ends with: tests green in CI; `wrangler deploy` succeeded; `README.md` / `RUNBOOK.md` updated; a `docs/DECISIONS.md` entry for any deviation; a short transcript of a real question and answer from the Claude app in `docs/demos/phase-N.md`; and a go/no-go check-in with me.

**Phase 0 — Prove the pipe (smallest possible)**
Scaffold from Cloudflare's official remote MCP template (`npm create cloudflare@latest -- fantasy-intelligence-mcp --template=cloudflare/ai/demos/remote-mcp-authless` — verify the current template name; it uses `McpAgent` on Durable Objects, so confirm free-plan support, and fall back to the stateless MCP SDK transport if needed). Two tools: `ping` and `get_nfl_state` (Sleeper `state/nfl`). Authless. Test locally with `wrangler dev` + MCP Inspector. Deploy. CI with typecheck + tests. I add the URL as a custom connector at claude.ai (mobile can use it once added there) and confirm a tool call works from my phone. If ChatGPT is in scope, verify its current custom-MCP requirements separately and list any gaps. **Stop here until I confirm.**

**Phase 1 — League and players (no API keys)**
Sleeper adapters with fixtures. D1 schema + migrations. Canonical IDs + crosswalk (Sleeper cross-IDs ∪ nflverse `ff_playerids`); measure the unresolved rate and report it. Tools: `get_my_leagues`, `set_default_league`, `get_league`, `search_players`, `get_roster` (injury, bye, slot; no projections yet). OAuth (owner-only) in front of `/mcp`. Daily `players/nfl` job; apply the CPU budget rule.

**Phase 2 — Projections and start/sit**
Projection provider(s) per Section 5. nflverse weekly-stats ETL → D1; `defense_vs_position` and usage trends materialized. Engine: consensus, range, matchup, injury gates, confidence, lineup. Tools: `compare_players`, `recommend_lineup`, `get_player_profile` (without environment/news yet).

**Phase 3 — Game environment**
Schedules with roof/venue (nflverse `games`), `stadiums.json`, Odds API adapter with budget counter, Open-Meteo for outdoor games. Tool: `get_game_environment`. Environment factor wired into the Phase 2 tools.

**Phase 4 — News, waivers, trades**
RSS + Sleeper injury-delta job → `news_items`. Tools: `get_news` (with `since`), `get_waiver_targets`, `evaluate_trade`.

**Phase 5 — Matchup, playoffs, polish**
Tools: `get_matchup_preview`, `get_playoff_outlook`. MCP prompts and resources. Rate limiting per OAuth subject. Structured request logs (tool, ms, providers hit, cache hits, errors). `/health` with freshness. README: clone-to-connected in 15 minutes.

## 12. How to work

- **First action**: save this message verbatim as `docs/SPEC.md`. Create `CLAUDE.md` with: the stack, the commands (`test`, `typecheck`, `dev`, `deploy`, `db:migrate`), the import discipline, these working rules, and a `Current phase:` line you keep updated.
- **Before coding each phase**, read the relevant official docs (Cloudflare Workers, Agents, and OAuth provider; the MCP TypeScript SDK; Sleeper API docs; nflverse-data release notes) and confirm field names with a real request. Post a plan of at most 15 lines plus any questions, then start.
- **Ask, don't assume**, when: a provider is unavailable or its ToS is unclear; a free-tier limit forces a design change; you want a new dependency or a paid plan; you want to change a methodology default; a change would touch more than about five files outside the current phase's scope.
- **Simplest correct solution.** No plugin frameworks, generic event buses, retry decorators, or abstraction layers with one implementation. Three similar lines beat a premature helper. Edit existing code before adding files.
- **Boundaries are typed**: zod at the edges (provider responses, tool inputs); domain types inside; no `any`.
- **Tests test behavior**: engine math against hand-verified numbers; adapters against recorded fixtures; one integration test per tool through the MCP server using `@cloudflare/vitest-pool-workers`. No tests that only assert a mock was called.
- **Graceful degradation is a feature**, not error handling: a missing provider changes `caveats` and `confidence`, never the HTTP status.
- **Secrets** via `wrangler secret put`; commit `.dev.vars.example`; never log secrets or full provider payloads.
- **Comments explain why.** No boilerplate docstrings, no emoji, no TODO stubs, no commented-out code, no dead code.
- **Commits**: small, one concern each, conventional messages. Lead each check-in with what changed and why, then deviations, then risks, then follow-ups you noticed but did not do.
- **Verify, don't recall**: platform limits, template names, endpoint shapes, and feed URLs change. When this spec and the live docs disagree, the live docs win — and tell me.

## 13. Out of scope for v1

Dynasty valuations and rookie picks; DFS; player props; ESPN/Yahoo leagues (the adapter interface leaves room); push notifications; multi-user SaaS; a web dashboard; any server-side LLM call.

## 14. Definition of done

From the Claude app on my phone, "Should I start X or Y this week?" returns a grounded answer with evidence, sources, and confidence in under about 10 seconds. All eight outputs from the diagram map to at least one tool. Nothing paid is required. CI is green. Fixtures refresh by script. A new user goes from clone to connected connector in 15 minutes using only the README.
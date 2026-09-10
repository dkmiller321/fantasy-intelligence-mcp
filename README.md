# Fantasy Intelligence MCP

A remote MCP server on Cloudflare Workers that turns the Claude app into a personal
fantasy football analyst for a Sleeper league.

Ask from your phone: *"Should I start Hampton or Warren this week?"* and get a grounded
answer with the reasoning shown.

```
Start Omarion Hampton over Jaylen Warren, by 5.7 projected points.
confidence 0.7

  Omarion Hampton   17.9  floor 11.8  ceiling 24.0  vs ARI  matchup rank 3   implied 28.5
  Jaylen Warren     12.1  floor  3.6  ceiling 20.7  vs ATL  matchup rank 21  implied 23.5

evidence
  0  Hampton: consensus projection = 15.0 (single source)
  +  Hampton: matchup = x1.09 (vs ARI, generous to this position)
  +  Hampton: game environment = x1.10 (implied team total 28.5, dome)
  -  Warren:  matchup = x0.98 (vs ATL, stingy to this position)

caveats
  - Week 1: matchup grades come entirely from 2025 data.
  - Projections come from a single source, so confidence is capped at 0.7.
```

## What makes it different

**The server never calls a language model.** Every number is deterministic, testable
arithmetic; the client model does the reasoning and the prose. That keeps running cost at
zero, makes recommendations reproducible, and lets the engine be unit-tested against
hand-computed values.

**Nothing paid is required.** Sleeper, nflverse, Open-Meteo and public RSS are all keyless.
Betting lines come from the nflverse schedule, so no odds API account is needed.

**It shows its work.** Every response carries the factors that produced the number, the
sources with timestamps, and honest caveats. When ten of eighteen lineup slots are inside
the noise, it says so rather than implying precision it does not have.

**It handles IDP.** The reference league starts seven individual defensive players out of
eighteen. Points are recomputed from stat lines against the league's own scoring, because
providers score IDP wrong by more than an order of magnitude.

## Clone to connected in 15 minutes

```bash
git clone https://github.com/dkmiller321/fantasy-intelligence-mcp
cd fantasy-intelligence-mcp
npm install
npx wrangler login
```

Create the resources and note the ids it prints:

```bash
npx wrangler d1 create fantasy
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create OAUTH_KV
```

Put those ids in `wrangler.jsonc`, along with your Sleeper username and league id in
`vars`. Then:

```bash
npx wrangler d1 migrations apply fantasy --remote
npm run sync:players -- --remote          # ~10k players and the id crosswalk
npm run etl -- --seasons 2025,2026 --remote   # weekly stats and schedules
npm run sync:projections -- --remote
npm run materialize -- --remote           # matchup grades
npm run seed:stadiums                     # stadium coordinates from Wikidata
```

Set a password and deploy:

```bash
npx wrangler secret put OWNER_PASSWORD
npm run deploy
```

Add `https://<your-worker>.workers.dev/mcp` as a custom connector at claude.ai, sign in
with that password, and it is available in the mobile apps too.

Run the whole backfill in one sitting: D1's free tier allows 100,000 row writes per day
and a full load uses about 64,500.

## The tools

| Tool | Answers |
|---|---|
| `get_nfl_state` | What week is it |
| `get_my_leagues` | Which leagues am I in |
| `set_default_league` | Use this league from now on |
| `get_league` | Scoring, slots, playoff weeks, standings |
| `search_players` | Resolve a name to an id |
| `get_roster` | Who is on my team, with injuries and byes |
| `get_player_profile` | How is this player looking |
| `compare_players` | Start X or Y |
| `recommend_lineup` | Set my whole lineup |
| `get_game_environment` | Weather, spreads, implied totals |
| `get_news` | What changed since I last looked |
| `get_waiver_targets` | Who should I add, and what should I bid |
| `evaluate_trade` | Should I accept this trade |
| `get_matchup_preview` | Can I win this week |
| `get_playoff_outlook` | Who has the best playoff schedule |

Plus prompts `weekly_lineup_review`, `waiver_wire_wednesday`, `trade_check`, and resources
`league://settings` and `doc://methodology`.

## How it works

```
Claude app
    |
    v  OAuth 2.1 + PKCE, owner-only
Cloudflare Worker  ── /mcp  stateless MCP handler
    |                       reads D1, light arithmetic, 10 ms CPU
    |
    +-- D1     players, stats, projections, matchup grades, news
    +-- KV     provider cache, rate limits
    |
    ^
    |  writes
GitHub Actions (weekly)      Worker cron
  nflverse ETL                 news, 15 min
  player sync                  weather, 6 h
```

Requests never fan out to six APIs. Everything expensive is ingested on a schedule and
read back as rows, which is what keeps mobile latency low and the free tier viable.

## Documentation

- [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md) — every formula and weight
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operations, limits, diagnosing a bad answer
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — every deviation from the spec and why
- [`docs/SPEC.md`](docs/SPEC.md) — the original build specification

## Development

```bash
npm test           # 160 tests: engine math, provider contracts, MCP integration
npm run typecheck
npm run lint
npm run dev        # local worker on :8787
npm run call -- get_nfl_state    # call the deployed server through real OAuth
```

Engine code under `src/engine/` is pure: no `fetch`, no `env`, no `Date.now()`. Time is
always a parameter. That is what makes the math testable.

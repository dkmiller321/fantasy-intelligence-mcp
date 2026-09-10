# Phase 1 — league and players

## What shipped

D1 schema (13 tables) with migrations. Canonical player ids resolved through the
dynastyprocess crosswalk. Sleeper adapters with fixtures. Owner-only OAuth in front of
`/mcp`. Five tools: `get_my_leagues`, `set_default_league`, `get_league`,
`search_players`, `get_roster`.

## Crosswalk resolution rate, as SPEC Phase 1 asks

| Source | Rostered players resolved |
|---|---|
| Sleeper `gsis_id` alone | 78 of 421 (19%) |
| plus dynastyprocess `db_playerids` | 407 of 421 (97%) |
| unresolved | 14 (3.3%), all 2026 rookies |

Across all 9,878 loaded players the unresolved rate is 33%, which is dominated by
retired and practice-squad players who have no NFL id anywhere and no stats to join to.
The number that matters is the rostered one.

## Real transcripts

`get_league`:

```
Franchise Player: 10-team dynasty, 0.25 PPR, 18 starters, playoffs begin week 14.
myTeamId 3, waiver faab 200
standings: 1. Webber Warriors 0-0 | 2. ACL & Battery 0-0 | 3. Draft - Tank - Survive 0-0 (mine)
```

`get_roster`:

```
Draft - Tank - Survive: 29 active players, 12 on taxi, 1 on IR.
18 starting slots (7 IDP).
active by position: RB 7, QB 4, TE 3, LB 6, K 1, WR 6, DB 1, DL 1
caveats:
  - 1 rostered player has no cross-provider id, usually 2026 rookies.
  - Injury designations: Brock Bowers doubtful (Knee - Meniscus),
    Jakobi Meyers questionable (Hand).
```

`search_players` for "jefferson" returns ten candidates and correctly separates two
different players who share a name:

```
Justin Jefferson | WR | MIN | 00-0036322
Justin Jefferson | LB | CLE | 00-0041075
```

That pair is the argument for canonical ids in one line.

## Auth

`/mcp` returns 401 without a bearer token. Dynamic Client Registration and PKCE S256 are
advertised at `/.well-known/oauth-authorization-server`, which is what claude.ai
requires. Seven integration tests drive the real flow: register, approve with the owner
password, exchange the code with a verifier, then call a tool.

## Deviations

- Canonical id resolution needed the dynastyprocess crosswalk (DECISIONS D12).
- `players/nfl` sync moved out of Worker cron into a Node script (DECISIONS D13).
- The R sentinel "NA" was being stored as a real id; caught, fixed, regression-tested
  (DECISIONS D12, `test/unit/csv.test.ts`).

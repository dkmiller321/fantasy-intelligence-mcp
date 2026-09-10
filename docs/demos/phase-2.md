# Phase 2 — projections and start/sit

## What shipped

nflverse ETL (16,520 weekly stat rows for 2025 including IDP, 557 games with betting
lines), Sleeper projections recomputed under league scoring, materialized
defense-vs-position for all 32 teams across 8 positions, and the projection engine.
Tools: `compare_players`, `recommend_lineup`, `get_player_profile`.

## Real transcript: compare_players

```
SUMMARY : Start Omarion Hampton over Jaylen Warren, by 5.7 projected points.
LEAN    : Omarion Hampton | margin 5.7 | confidence 0.7

  Omarion Hampton     17.9 floor 11.8 ceil 24.0 | vs ARI  DvP rank  3 | implied 28.5
  Jaylen Warren       12.1 floor  3.6 ceil 20.7 | vs ATL  DvP rank 21 | implied 23.5

EVIDENCE:
  0 Hampton: consensus projection = 15 (single source (sleeper))
  + Hampton: matchup = x1.09 (vs ARI, generous to this position)
  + Hampton: game environment = x1.10 (implied team total 28.5, dome)
  0 Warren: consensus projection = 12.2 (single source (sleeper))
  - Warren: matchup = x0.98 (vs ATL, stingy to this position)
  + Warren: game environment = x1.02 (implied team total 23.5)

CAVEATS:
  - Week 1: matchup grades come entirely from 2025 data, because this season has
    no games yet. They describe last year's defences.
  - Projections come from a single source (Sleeper), so confidence is capped at 0.7.
```

Every multiplier is shown, so the answer can be argued with rather than taken on faith.

## Real transcript: recommend_lineup

All eighteen slots, including the seven IDP ones:

```
3 changes recommended; projected 172.4 points after them.

  QB        Matthew Stafford        25.0  vs SF
  RB        Javonte Williams        20.5  @ NYG
  RB        Omarion Hampton         17.9  vs ARI
  WR        Jayden Reed              8.9  @ MIN   <- close (0.6)
  WR        Rashee Rice              8.3  vs DEN  <- close (1.1)
  TE        Hunter Henry             6.6  @ SEA   <- close (1.4)
  FLEX      Jaylen Warren           12.1  vs ATL
  FLEX      Blake Corum              9.9  vs SF
  FLEX      RJ Harvey                7.6  @ KC    <- close (0.5)
  REC_FLEX  Khalil Shakir            7.2  @ HOU   <- close (0.1)
  K         Ka'imi Fairbairn         6.2  vs BUF
  DL        Aidan Hutchinson         8.1  vs NO
  LB        Edgerrin Cooper          7.0  @ MIN   <- close (0.6)
  DB        Dillon Thieneman         4.8  @ CAR
  IDP_FLEX  Sonny Styles             6.5  @ PHI   <- close (1.0)
  IDP_FLEX  Carson Schwesinger       5.5  @ JAX   <- close (0.2)
  IDP_FLEX  Nik Bonitto              5.3  @ KC    <- close (0.1)
  IDP_FLEX  Arvell Reese             5.1  vs DAL  <- close (0.6)

start: Stafford (QB), Hunter Henry (TE), Khalil Shakir (WR)
sit:   Kyler Murray (22.9), Marvin Harrison (6.7), Dalton Schultz (5.2)

caveat: 10 slot decisions are within 1.5 projected points, which is inside the
        noise of any projection. Treat those as toss-ups.
```

That last caveat matters more than the ranking. Ten of eighteen slots are coin flips,
and the tool says so rather than implying false precision.

## Data quality checks

- IDP scoring verified against a hand-computed line: a projected LB at 1.32 solo,
  1.83 assists, 0.15 sacks, 0.15 passes defended, 0.31 TFL scores 3.30 in this league.
  Sleeper reports that same line as `pts_ppr: 0.15`, a factor of 22 (DECISIONS D5).
- Defense-vs-position spreads look like football: WRs face 21.7 points per game against
  MIN and 34.4 against DAL.
- 911 projections loaded for week 1, one without a canonical id.

## Deviations

- nflverse `schedules/games.csv` already carries `spread_line` and `total_line`, so
  implied team totals are available with no API key. The Odds API is not needed for v1
  (DECISIONS D14).
- Lineup optimization is greedy, most-constrained-slot-first, rather than a full
  assignment solve. Documented in `src/engine/lineup.ts` with the reasoning.

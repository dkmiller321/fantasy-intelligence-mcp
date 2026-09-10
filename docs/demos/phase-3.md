# Phase 3 — game environment

## What shipped

Schedules with roof, venue and betting lines from nflverse. Stadium coordinates built
from Wikidata. Open-Meteo forecasts for outdoor games on a 6-hourly cron. The environment
multiplier wired into every projection. Tool: `get_game_environment`.

## The Odds API turned out to be unnecessary

SPEC section 5 budgets 240 of 500 free monthly credits for spreads and totals. The
nflverse `schedules/games.csv` release already carries `spread_line` and `total_line`, so
implied team totals cost nothing and need no account (DECISIONS D14).

## Real transcript

```
16 games in week 1. Highest total: TB at CIN at 50.5.

  NE @ SEA    total 44.5 | implied 20.8 / 23.8 | outdoors
  SF @ LA     total 48.5 | implied 22.5 / 26.0 | dome
  CHI @ CAR   total 46.5 | implied 24.8 / 21.8 | outdoors
  TB @ CIN    total 50.5 | implied 23.5 / 27.0 | outdoors
  NO @ DET    total 50.5 | implied 21.8 / 28.8 | dome
```

Those implied totals are what drive the environment multiplier: Detroit's 28.8 lifts their
skill players about 10%, the cap.

## Stadium coordinates

`npm run seed:stadiums` queries Wikidata for each NFL team's home venue and its
coordinates, then matches them to nflverse abbreviations. 32 teams resolved; the three
unmatched are retired abbreviations (OAK, SD, STL) that the alias map already folds into
LV, LAC and LA. Verified against the schedule: all 32 home teams have coordinates.

Written from a queryable source rather than from memory, per the SPEC's "verify, don't
recall" rule.

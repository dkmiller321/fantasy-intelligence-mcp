# Phase 5 — matchup, playoffs, polish

## What shipped

Tools `get_matchup_preview` and `get_playoff_outlook`. Three MCP prompts, two resources,
per-subject rate limiting, structured request logging, and a `/health` endpoint reporting
per-source freshness. `ping` removed (DECISIONS D16), leaving the SPEC's fifteen tools.

## Real transcript: get_matchup_preview

```
56% to beat JeremiyahLove: 172.4 projected against 167.8, a 4.6-point edge.

  me       Draft - Tank - Survive   172.4  spread 24.6
  opponent JeremiyahLove            167.8  spread 23.9
  winProbability 0.56

swing players
  Jaylen Warren     3.6 - 20.7   range 17.1
  Blake Corum       1.8 - 17.9   range 16.1
  Matthew Stafford 17.4 - 32.6   range 15.2
```

A 4.6-point edge over a combined spread of ~34 is 56%, not 80%. The tool resists the
temptation to sound more certain than the arithmetic allows, and says outright that
treating starters as independent understates correlation.

## Real transcript: get_playoff_outlook

```
Playoff weeks 14, 15, 16, 17.

best   Nik Bonitto        LB  0.77
       Matthew Stafford   QB  0.71
       Aidan Hutchinson   DL  0.71
       Kyler Murray       QB  0.70

worst  Romeo Doubs        WR  0.14
       Brock Purdy        QB  0.26
```

## Tool consolidation

SPEC section 7 asks whether fifteen tools should become about twelve. Exercised against
the real league they do not overlap: each maps to a distinct question. Only `ping` was
cut, as a Phase 0 scaffold that told the model nothing `get_nfl_state` does not.
Reasoning recorded in DECISIONS D16.

## What running it for real found

Three defects that tests had not, all of which produced confident wrong answers:
read-only tools writing on every call, waiver targets ranked by raw points (six
quarterbacks), and replacement level computing as zero for every position but quarterback.
All three are described in DECISIONS D17, with regression coverage.

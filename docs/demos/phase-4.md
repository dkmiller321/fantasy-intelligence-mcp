# Phase 4 — news, waivers, trades

## What shipped

RSS ingestion from three verified feeds on a 15-minute cron, with player matching and
impact classification. Waiver scoring with FAAB bands. Trade valuation over replacement
with a dynasty age curve. Tools: `get_news`, `get_waiver_targets`, `evaluate_trade`.

## Real transcript: get_news, scoped to the roster

```
3 items.
  [low   ] Romeo Doubs on his no-catch, big-drop game: I'll be better moving forward
             -> Romeo Doubs
  [low   ] Top predicted anytime TD scorers for Week 1
             -> Jahmyr Gibbs, Omarion Hampton
  [low   ] Facts vs. Feelings: Seven players who will get off to fast starts
             -> D'Andre Swift, Rashee Rice, Quinshon Judkins, Tetairoa McMillan, ...
```

91 items ingested from ESPN, ProFootballTalk and CBS Sports; 75 matched to a player.
Passing `leagueId` narrows to players the owner actually holds, which is what makes
"anything new on my roster" a single call.

Matching is deliberately conservative. A full normalized name must appear, or a surname
that identifies exactly one player in the index. There are two Justin Jeffersons in the
league's player pool, a receiver in Minnesota and a linebacker in Cleveland, so a bare
"Jefferson" attaches to neither. Attaching news to the wrong player is worse than
attaching it to none.

## Real transcript: get_waiver_targets

```
Top target: Ventrell Miller (LB), bid $2-$6.

  Ventrell Miller     LB  proj 7.5  upgrade +2.4  score 0.47  $2-$6
  Jake Bates          K   proj 8.5  upgrade +2.3  score 0.46  $2-$6
  Tyler Loop          K   proj 8.3  upgrade +2.1  score 0.44  $2-$6
  Andrew Van Ginkel   LB  proj 6.7  upgrade +1.6  score 0.40  $2-$6
  Drue Tranquill      LB  proj 6.6  upgrade +1.5  score 0.39  $2-$6
  Jalen Thompson      DB  proj 6.0  upgrade +1.2  score 0.36  $2-$6

  caveat: 200 FAAB remaining of 200.
```

Linebackers, kickers and a defensive back, which are exactly the slots this roster is
thin at. The first version of this tool returned six quarterbacks, because quarterbacks
score the most points and the ranking was on raw projection. That is useless advice to
someone who starts one quarterback and already rosters four. Candidates are now scored
by how much they would improve *this* lineup over the weakest starter they are eligible
to displace (DECISIONS D17). The bids are small because the upgrades are small, which is
the honest answer.

## Real transcript: evaluate_trade

Give a 23-year-old running back, receive a 38-year-old quarterback:

```
Decline: -188.1 net value (61.3 in, 249.4 out).

  give     Omarion Hampton  (RB, 23y)  ppg 17.9 | VOR 11.9 | age x1.09 => 249.4
  receive  Matthew Stafford (QB, 38y)  ppg 25.0 | VOR  4.0 | age x0.80 =>  61.3

  caveat: Dynasty age curve applied. Rookie draft picks are not valued at all.
  caveat: Playoff weeks 14-18 are weighted 25% above regular-season weeks.
```

Stafford outscores Hampton by seven points a week and is still the wrong side of this
trade, for two reasons the tool makes explicit. Quarterback is replaceable: the best one
on the waiver wire projects 21, so Stafford's value over replacement is 4.0 against
Hampton's 11.9. And in a dynasty league a 38-year-old carries a 0.80 age multiplier
against a 23-year-old's 1.09.

Getting this right required fixing a defect where replacement level computed as zero for
every position except quarterback, which had inflated Hampton's value by roughly a factor
of two in the other direction (DECISIONS D17).

## Deviations

- Sleeper's injury fields remain the authoritative status signal; RSS supplies narrative.
  `get_news` reports both timestamps so staleness is visible.
- Rookie draft picks are not valued, and a trade containing them says so (DECISIONS D8).

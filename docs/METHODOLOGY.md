# Methodology

Every number this server returns is deterministic arithmetic over stored data. The server
never calls a language model. Each weight below lives in `src/engine/config.ts` and each
function has unit tests against hand-computed numbers.

## Scoring

Points are always recomputed from a stat line against the league's own `scoring_settings`,
never read from a provider's points field.

This is not a refinement. For a projected linebacker line of 1.32 solo tackles, 1.83
assists, 0.15 sacks, 0.15 passes defended and 0.31 tackles for loss, this league scores:

```
1.32 x 1.0  = 1.320   solo tackles
1.83 x 0.5  = 0.915   assists
0.15 x 3.0  = 0.450   sacks
0.15 x 1.0  = 0.150   passes defended
0.31 x 1.5  = 0.465   tackles for loss
              -----
              3.300
```

Sleeper reports that same line as `pts_ppr: 0.15`, a factor of 22 out, because its preset
formats do not score IDP. Seven of this league's eighteen starting slots are IDP, so
trusting the provider would corrupt 39% of every lineup decision.

Historical results are scored the same way, so a player's past weeks are measured by
exactly the rules that will measure their next one.

## Consensus projection

Weighted mean of the sources available for a player and week. FantasyPros carries 0.6 and
Sleeper 0.4 when both exist. With one source it takes full weight, and confidence is
capped at 0.7 regardless of how good the answer looks.

Agreement is `1 - spread / (2 x mean)`, clamped to [0, 1], and feeds confidence.

## Range

In order of preference:

1. Provider floor and ceiling, averaged.
2. One standard deviation of the player's last six scored weeks, given at least three.
3. A position-level sigma.

A questionable designation widens the band by 25%.

## Matchup

The opponent's fantasy points allowed per game to the position, over a rolling six-week
window, expressed as a z-score against the league and converted to a multiplier:

```
multiplier = clamp(1 + z x 0.06, 0.85, 1.15)
```

Points allowed is computed per game, not per player-row: a defence that faced two
receivers scoring 10 and 20 in one week allowed 30 that week, not an average of 15.

Rank 1 is the most generous defence, so a low rank is a good matchup to attack.

### Early season

The six-week window is empty until roughly week 7. Prior-season data is blended in on a
linear curve: full weight through week 1, about half at week 4, none from week 7.

```
priorWeight(week) = clamp((7 - week) / 6, 0, 1)
```

The prior component uses the previous season in full rather than its last six weeks. A
larger sample is steadier, and six-week recency from a completed season says no more about
a reshaped roster than the whole year does. Every affected response carries a caveat
naming the blend, and `defense_vs_position.prior_weight` records it per row.

## Game environment

Implied team total comes from the betting line carried in the nflverse schedule:

```
impliedHome = total/2 + spread/2
impliedAway = total/2 - spread/2
```

That is turned into a z-score against the week's slate and clamped:

```
multiplier = clamp(1 + z x 0.05, 0.90, 1.10)
```

Weather applies to outdoor and open-roof games only. Wind at or above 15 mph multiplies
QB, WR, TE and K by 0.92. A precipitation probability at or above 60% multiplies everyone
by 0.96. Domes and closed roofs are exactly 1.0.

## Injuries

Out, doubtful, IR, PUP and suspended players are excluded from lineups but still returned,
so the user can see why. Questionable multiplies by 0.90 and adds a caveat.

## Usage trend

The last three weeks against the three before them, for snap share, target share, carries
and points. A change beyond 0.05 is labelled rising or falling; anything smaller is flat.
With fewer than two full windows the trend is reported as unknown rather than invented.

## Composite

```
points = consensus x matchup x environment x injury
```

Each factor's contribution appears in the response's `evidence` array, so the model can
explain the number and overrule it with context the server does not have.

## Confidence

```
confidence = 0.5
           + 0.20 x sourceAgreement
           + 0.20 x projectionGap
           - 0.15 x injuryUncertain
           - 0.10 x missingSources
```

Clamped to [0.05, 0.95], then capped at 0.7 when only one source exists. `projectionGap`
is the normalized distance between the leading option and the runner-up, so a blowout
decision is more confident than a coin flip.

## Lineup

Slots are filled most-constrained-first, so a scarce slot claims its only eligible player
before a flex can absorb them. Eligibility comes from `fantasy_positions`, which is
multi-valued: a player listed DL and LB fills either.

This is greedy, not a full assignment search. With eighteen slots and about thirty
candidates an optimal solve is feasible, but the greedy order matches how a manager
reasons and stays inside the request CPU budget. Every slot reports its runner-up and the
margin, and margins under 1.5 points are flagged as coin flips.

## Waivers

```
score = 0.85 x (0.5 x rosValue + 0.3 x usageTrend + 0.2 x opportunity)
      + 0.15 x trendingAdds
```

Trending adds are a crowd signal rather than an analytical one, so they nudge the ranking
and tell you what a bid must beat, without driving it. FAAB bands by score tier are
1-3%, 5-10%, 15-25% and 30-50% of the season budget.

## Trades

Each player is valued over replacement, where replacement is the best free agent at that
position in this league:

```
value = (pointsPerGame - replacementPpg)
      x (regularWeeks + playoffWeeks x 1.25)
      x ageMultiplier
```

Playoff weeks count 25% more because they decide the season.

The age multiplier exists because this league is dynasty. Below the positional peak a
player earns a small premium per year; beyond it, value decays at a per-position rate
(running backs fastest, at 9% per year past 26). The whole adjustment is capped at 35%, so
age can shade a verdict but never invert a large on-field gap.

Rookie draft picks are not valued. There is no keyless, terms-clean source for pick values,
and a table written from memory could not be verified or tested. A trade containing picks
returns a caveat saying they are unpriced.

## Matchup win probability

Each team's weekly total is treated as normal, with the mean from the optimal lineup and
sigma combined in quadrature from per-player bands. Win probability is the normal CDF of
the standardized difference.

Treating starters as independent understates correlation, because a quarterback and their
receiver rise together. Real outcomes are therefore slightly more extreme than this
suggests, and the tool says so.

## Playoff outlook

For each playoff week, the opponent's defence-vs-position rank becomes a percentile where
1.0 is the easiest matchup. A player's score is the mean across playable weeks; bye weeks
are excluded from the average and flagged separately.

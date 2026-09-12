/**
 * Every tunable the engine uses. SPEC section 8 fixes these defaults; changing one is a
 * decision that belongs in docs/DECISIONS.md and docs/METHODOLOGY.md.
 */

export const CONFIG = {
  /** Source weights when several projections exist for the same player and week. */
  sourceWeights: {
    // FantasyPros is a consensus of many analysts, so it outweighs any single vendor if
    // a key is ever obtained. ESPN and Sleeper are each one house projection and are
    // weighted evenly against each other (DECISIONS D20).
    fantasypros: 0.6,
    espn: 0.35,
    sleeper: 0.35,
  } as Record<string, number>,

  /** A single source can never express more than this much confidence. */
  singleSourceConfidenceCap: 0.7,

  range: {
    /** Weeks of history used for the standard deviation behind floor and ceiling. */
    lookbackWeeks: 6,
    /** Below this many games, fall back to a position-level sigma. */
    minGames: 3,
  },

  matchup: {
    /** Rolling window of opponent points allowed to a position. */
    windowWeeks: 6,
    /** Multiplier bounds; matchup nudges a projection, it does not rewrite it. */
    min: 0.85,
    max: 1.15,
    /** Multiplier per standard deviation of opponent generosity. */
    perZ: 0.06,
  },

  environment: {
    min: 0.9,
    max: 1.1,
    perZ: 0.05,
    /** Outdoor games only. */
    windThresholdMph: 15,
    windMultiplier: 0.92,
    /** Positions a strong wind actually suppresses. */
    windAffects: ["QB", "WR", "TE", "K"] as const,
    precipThreshold: 0.6,
    precipMultiplier: 0.96,
  },

  injury: {
    /** Cannot be started; still shown so the user knows why. */
    excluded: ["out", "ir", "doubtful", "suspended", "pup"] as const,
    questionableMultiplier: 0.9,
    /** Widens the floor/ceiling band for a questionable player. */
    questionableRangeWiden: 1.25,
  },

  usage: {
    /** Recent window compared against the window immediately before it. */
    windowWeeks: 3,
    /** Share change beyond this counts as rising or falling rather than flat. */
    risingThreshold: 0.05,
  },

  confidence: {
    base: 0.5,
    sourceAgreement: 0.2,
    projectionGap: 0.2,
    injuryUncertainty: 0.15,
    missingSources: 0.1,
    min: 0.05,
    max: 0.95,
  },

  waivers: {
    rosValueWeight: 0.5,
    usageTrendWeight: 0.3,
    opportunityWeight: 0.2,
    /** FAAB bid bands as a percentage of the season budget, by score tier. */
    faabBands: [
      { minScore: 0.85, low: 30, high: 50 },
      { minScore: 0.7, low: 15, high: 25 },
      { minScore: 0.5, low: 5, high: 10 },
      { minScore: 0, low: 1, high: 3 },
    ],
  },

  trade: {
    /** Weeks at or after playoffWeekStart matter more than regular-season weeks. */
    playoffWeekMultiplier: 1.25,
    /**
     * Dynasty age adjustment (DECISIONS D8). Peak age per position, and how much value
     * decays per year beyond it. Rookie picks are not valued.
     */
    ageCurve: {
      QB: { peak: 33, declinePerYear: 0.04 },
      RB: { peak: 26, declinePerYear: 0.09 },
      WR: { peak: 28, declinePerYear: 0.05 },
      TE: { peak: 28, declinePerYear: 0.05 },
      K: { peak: 32, declinePerYear: 0.01 },
      DL: { peak: 28, declinePerYear: 0.05 },
      LB: { peak: 28, declinePerYear: 0.05 },
      DB: { peak: 28, declinePerYear: 0.05 },
      DEF: { peak: 28, declinePerYear: 0 },
    } as Record<string, { peak: number; declinePerYear: number }>,
    /** Young players below peak get a modest premium, capped so it cannot dominate. */
    youthPremiumPerYear: 0.03,
    maxAgeAdjustment: 0.35,
  },

  /**
   * Prior-season blend (DECISIONS D7, revised in D24).
   *
   * Shrinkage rather than a decay to zero: the weight on the prior season is
   * `k / (weeksPlayed + k)`, so the current season earns influence in proportion to how
   * much of it has actually happened, and the prior never disappears entirely.
   *
   * `k` is the number of current-season games at which the two sources carry equal
   * weight. It was fitted against 2024 and 2025 rather than chosen: the error curve is
   * flat between k=9 and k=15, and 9 is taken as the most responsive value inside that
   * range. The previous rule, decaying to zero by week 7, tested 7.1% worse.
   */
  priorSeasonBlend: {
    regressionConstantGames: 9,
  },
} as const;

/**
 * Fraction of a blended statistic that should come from the prior season.
 *
 * Defence-versus-position over a handful of games is a very noisy measurement: it depends
 * heavily on which offences a team happened to face. The prior season is a full eighteen
 * games and far steadier, so regressing toward it stays worthwhile deep into a season.
 * Backtested on 2025, abandoning the prior at week 7 cost 14-28% more error per week.
 */
export function priorSeasonWeight(weeksPlayed: number): number {
  const k = CONFIG.priorSeasonBlend.regressionConstantGames;
  if (weeksPlayed <= 0) return 1;
  return k / (weeksPlayed + k);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

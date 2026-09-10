/**
 * Every tunable the engine uses. SPEC section 8 fixes these defaults; changing one is a
 * decision that belongs in docs/DECISIONS.md and docs/METHODOLOGY.md.
 */

export const CONFIG = {
  /** Source weights when several projections exist for the same player and week. */
  sourceWeights: {
    fantasypros: 0.6,
    sleeper: 0.4,
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
   * Early-season blend (DECISIONS D7). Prior-season data carries full weight in week 1
   * and none from week 7, by which point the current season has a six-week window of
   * its own. Linear in between.
   */
  priorSeasonBlend: {
    fullPriorThroughWeek: 1,
    noPriorFromWeek: 7,
  },
} as const;

/** Fraction of a blended statistic that should come from the prior season. */
export function priorSeasonWeight(week: number): number {
  const { fullPriorThroughWeek, noPriorFromWeek } = CONFIG.priorSeasonBlend;
  if (week <= fullPriorThroughWeek) return 1;
  if (week >= noPriorFromWeek) return 0;
  return (noPriorFromWeek - week) / (noPriorFromWeek - fullPriorThroughWeek);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

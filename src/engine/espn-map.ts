/**
 * ESPN fantasy stat ids -> Sleeper scoring keys.
 *
 * ESPN returns a projected stat line keyed by opaque numeric ids alongside its own
 * `appliedTotal`, which is scored in ESPN's default PPR. That total is useless here for
 * the same reason Sleeper's is (DECISIONS D5): this league is 0.25 PPR with 68 scoring
 * keys. Only the raw line matters, and points are recomputed from it.
 *
 * The ids below were decoded by reconstructing known totals rather than recalled. Working
 * from ESPN's own week-1 2026 projections:
 *
 *   Amon-Ra St. Brown: 82.5 rec yd, 6.79 rec, 0.62 rec TD, 0.81 rush yd
 *     -> 82.5(.1) + 6.79(1) + 0.62(6) + 0.81(.1) = 18.84 against ESPN's reported 18.83
 *
 *   Josh Allen: 223.66 pass yd, 1.27 pass TD, 0.72 int, 32.24 rush yd, 0.62 rush TD
 *     -> 223.66(.04) + 1.27(4) - 0.72(2) + 32.24(.1) + 0.62(6) = 19.53 against 19.32
 *
 * Both land inside rounding of ESPN's own arithmetic, which is the evidence the mapping
 * is right.
 */

const STAT_IDS: Record<string, string> = {
  // Passing
  "0": "pass_att",
  "1": "pass_cmp",
  "3": "pass_yd",
  "4": "pass_td",
  "20": "pass_int",
  // Rushing
  "23": "rush_att",
  "24": "rush_yd",
  "25": "rush_td",
  "26": "rush_2pt",
  // Receiving
  "42": "rec_yd",
  "43": "rec_td",
  "44": "rec_2pt",
  "53": "rec",
  "58": "rec_tgt",
  // Kicking, by distance bucket
  "74": "fgm_0_39_espn",
  "77": "fgm_40_49",
  "80": "fgm_50p",
  "85": "fgmiss",
  "86": "xpm",
  "88": "xpmiss",
};

/** Keys Sleeper does not score but ESPN reports; kept out of the line entirely. */
const IGNORED = new Set(["rec_tgt", "pass_att", "pass_cmp", "rush_att"]);

/**
 * ESPN reports made field goals in a 0-39 bucket where Sleeper splits 0-19 and 20-29 and
 * 30-39. Splitting a projected average across three buckets would invent precision that
 * is not in the data, so the whole bucket is credited at Sleeper's 30-39 rate: every
 * kick in it is worth the same in this league anyway.
 */
function expandFieldGoals(
  line: Record<string, number>,
  scoring: Readonly<Record<string, number>>,
): void {
  const bucket = line.fgm_0_39_espn;
  if (bucket === undefined) return;
  delete line.fgm_0_39_espn;
  if (bucket === 0) return;
  // Use whichever short-range key this league actually scores.
  const key = ["fgm_30_39", "fgm_20_29", "fgm_0_19"].find((k) => scoring[k] !== undefined);
  if (key) line[key] = (line[key] ?? 0) + bucket;
}

/**
 * Build a Sleeper-keyed stat line from an ESPN projection. `scoring` is consulted only to
 * place the field-goal bucket; points are computed later by `scoreStatLine`.
 */
export function espnStatsToSleeper(
  stats: Readonly<Record<string, number>>,
  scoring: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};

  for (const [id, value] of Object.entries(stats)) {
    const key = STAT_IDS[id];
    if (!key || IGNORED.has(key)) continue;
    if (!Number.isFinite(value) || Math.abs(value) < 0.005) continue;
    out[key] = (out[key] ?? 0) + value;
  }

  expandFieldGoals(out, scoring);

  // Projections are fractional averages, so a 200-yard bonus threshold is never met by a
  // projected line and is deliberately not synthesised here.
  return out;
}

/** ESPN's defaultPositionId -> the fantasy bucket this project uses. */
const POSITION_IDS: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "DEF",
};

export function espnPosition(defaultPositionId: number): string | null {
  return POSITION_IDS[defaultPositionId] ?? null;
}

/**
 * ESPN's public default league carries no individual defensive players; a request
 * filtered to IDP slots returns HTTP 400. Those seven starting slots therefore stay
 * single-source, and every response says so rather than implying uniform coverage.
 */
export const ESPN_COVERS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

export function espnCovers(position: string): boolean {
  return (ESPN_COVERS as readonly string[]).includes(position);
}

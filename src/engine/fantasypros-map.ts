/**
 * FantasyPros stat keys -> Sleeper scoring keys.
 *
 * FantasyPros returns `points`, `points_ppr` and `points_half` alongside the stat line.
 * None of those are used, for the same reason Sleeper's and ESPN's are not: this league
 * is 0.25 PPR with 68 keys and 19 of them IDP. Only the raw line matters (DECISIONS D5).
 *
 * `def_tackle` is solo tackles, not combined. That was established against ground truth
 * rather than assumed, because the two readings differ by a factor of nearly two under
 * this league's scoring:
 *
 *   Jack Campbell actually scored 10.28 points per game in 2025.
 *     reading def_tackle as solo  -> 11.21 projected, plausible
 *     reading it as combined      ->  6.93 projected, a third low for an every-down
 *                                     linebacker, and implausible
 *
 * The structural argument agrees: `def_assist` is returned as its own field, so counting
 * assists inside `def_tackle` would double-count them.
 */

const DIRECT: Record<string, string> = {
  // Passing
  pass_yds: "pass_yd",
  pass_tds: "pass_td",
  pass_ints: "pass_int",
  // Rushing
  rush_yds: "rush_yd",
  rush_tds: "rush_td",
  // Receiving
  rec_rec: "rec",
  rec_yds: "rec_yd",
  rec_tds: "rec_td",
  // Kicking
  xpt: "xpm",
  // Returns
  ret_tds: "st_td",
  // IDP
  def_tackle: "idp_tkl_solo",
  def_assist: "idp_tkl_ast",
  def_sack: "idp_sack",
  def_int: "idp_int",
  def_td: "idp_def_td",
  def_safety: "idp_safe",
  def_ff: "idp_ff",
  def_fr: "idp_fum_rec",
  def_pd: "idp_pass_def",
  def_tlost: "idp_tkl_loss",
};

/**
 * FantasyPros projects total field goals made without a distance split, where this league
 * scores 0-19, 20-29, 30-39, 40-49 and 50+ separately. Spreading a projected average
 * across buckets would invent precision that is not in the data, so the total is credited
 * at the league's mid-range rate, which is what the majority of kicks are worth.
 */
function placeFieldGoals(
  line: Record<string, number>,
  made: number,
  scoring: Readonly<Record<string, number>>,
): void {
  if (made === 0) return;
  const key = ["fgm_30_39", "fgm_20_29", "fgm_0_19"].find((k) => scoring[k] !== undefined);
  if (key) line[key] = (line[key] ?? 0) + made;
}

export function fantasyProsStatsToSleeper(
  stats: Readonly<Record<string, number>>,
  scoring: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};

  for (const [key, value] of Object.entries(stats)) {
    const mapped = DIRECT[key];
    if (!mapped) continue;
    if (!Number.isFinite(value) || Math.abs(value) < 0.005) continue;
    out[mapped] = (out[mapped] ?? 0) + value;
  }

  // FantasyPros reports one `fumbles` figure in projections, which is fumbles lost.
  const fumbles = stats.fumbles;
  if (typeof fumbles === "number" && fumbles >= 0.005) out.fum_lost = fumbles;

  const made = typeof stats.fg === "number" ? stats.fg : 0;
  placeFieldGoals(out, made, scoring);

  // Attempts minus makes; only counted where the league penalises a miss.
  const attempts = typeof stats.fga === "number" ? stats.fga : 0;
  const missed = attempts - made;
  if (missed >= 0.005 && scoring.fgmiss !== undefined) out.fgmiss = missed;

  // Yardage-bonus flags are thresholds a fractional projection never crosses, and
  // FantasyPros returns them as zero regardless; they are deliberately not synthesised.
  return out;
}

/** FantasyPros position ids that map onto a slot in this league. */
const POSITIONS: Record<string, string> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  DST: "DEF",
  DL: "DL",
  LB: "LB",
  DB: "DB",
};

export function fantasyProsPosition(positionId: string): string | null {
  return POSITIONS[positionId.trim().toUpperCase()] ?? null;
}

/**
 * Unlike ESPN, FantasyPros covers individual defensive players, so it is the only second
 * source available for the seven IDP slots in this league (DECISIONS D23).
 */
export const FANTASYPROS_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DL", "LB", "DB"] as const;

/**
 * nflverse `stats_player_week` columns -> Sleeper scoring keys.
 *
 * Keeping historical stats in Sleeper's key space means one scoring function serves both
 * projections and realized results, so a player's past weeks are scored by exactly the
 * rules that will score their next one.
 */

/** One nflverse column to one Sleeper key. */
const DIRECT: Record<string, string> = {
  // Passing
  completions: "pass_cmp",
  passing_yards: "pass_yd",
  passing_tds: "pass_td",
  passing_interceptions: "pass_int",
  passing_2pt_conversions: "pass_2pt",
  // Rushing
  rushing_yards: "rush_yd",
  rushing_tds: "rush_td",
  rushing_2pt_conversions: "rush_2pt",
  // Receiving
  receptions: "rec",
  receiving_yards: "rec_yd",
  receiving_tds: "rec_td",
  receiving_2pt_conversions: "rec_2pt",
  // IDP
  def_tackles_solo: "idp_tkl_solo",
  def_tackle_assists: "idp_tkl_ast",
  def_tackles_for_loss: "idp_tkl_loss",
  def_fumbles_forced: "idp_ff",
  def_sacks: "idp_sack",
  def_qb_hits: "idp_qb_hit",
  def_interceptions: "idp_int",
  def_interception_yards: "idp_int_ret_yd",
  def_pass_defended: "idp_pass_def",
  def_tds: "idp_def_td",
  def_safeties: "idp_safe",
  // Kicking
  pat_made: "xpm",
  pat_missed: "xpmiss",
  fg_made_0_19: "fgm_0_19",
  fg_made_20_29: "fgm_20_29",
  fg_made_30_39: "fgm_30_39",
  fg_made_40_49: "fgm_40_49",
  // Returns
  punt_return_yards: "pr_yd",
  kickoff_return_yards: "kr_yd",
};

function num(row: Readonly<Record<string, string>>, key: string): number {
  const raw = row[key];
  if (raw === undefined || raw === "" || raw === "NA") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build a Sleeper-keyed stat line from one nflverse weekly row. Only non-zero keys are
 * emitted, which keeps the stored JSON small and makes `scoreStatLine` cheap.
 */
export function toSleeperStatLine(row: Readonly<Record<string, string>>): Record<string, number> {
  const out: Record<string, number> = {};

  for (const [nflverseKey, sleeperKey] of Object.entries(DIRECT)) {
    const v = num(row, nflverseKey);
    if (v !== 0) out[sleeperKey] = v;
  }

  // Sleeper has one fumbles-lost key; nflverse splits by how the fumble happened.
  const fumblesLost =
    num(row, "rushing_fumbles_lost") +
    num(row, "receiving_fumbles_lost") +
    num(row, "sack_fumbles_lost");
  if (fumblesLost !== 0) out.fum_lost = fumblesLost;

  const fumbles =
    num(row, "rushing_fumbles") + num(row, "receiving_fumbles") + num(row, "sack_fumbles");
  if (fumbles !== 0) out.fum = fumbles;

  // Opponent fumbles recovered; own recoveries are not a scoring event in this league.
  const fumRec = num(row, "fumble_recovery_opp");
  if (fumRec !== 0) out.idp_fum_rec = fumRec;

  const fumRetYd = num(row, "fumble_recovery_yards_opp");
  if (fumRetYd !== 0) out.idp_fum_ret_yd = fumRetYd;

  // nflverse buckets 50-59 and 60+ separately; Sleeper has a single 50+ key.
  const fg50 = num(row, "fg_made_50_59") + num(row, "fg_made_60_");
  if (fg50 !== 0) out.fgm_50p = fg50;

  const fgMissed = num(row, "fg_missed");
  if (fgMissed !== 0) out.fgmiss = fgMissed;

  const blocks =
    num(row, "def_punt_blocks") + num(row, "def_pat_blocks") + num(row, "def_fg_blocks");
  if (blocks !== 0) out.idp_blk_kick = blocks;

  // Yardage bonuses are threshold flags, not counters.
  if (num(row, "receiving_yards") >= 200) out.bonus_rec_yd_200 = 1;

  const stTds = num(row, "special_teams_tds");
  if (stTds !== 0) out.st_td = stTds;

  return out;
}

/** Usage columns, kept separate from scoring because they drive trends, not points. */
export function toUsage(row: Readonly<Record<string, string>>): {
  targets: number;
  targetShare: number;
  carries: number;
  tacklesSolo: number;
} {
  return {
    targets: num(row, "targets"),
    targetShare: num(row, "target_share"),
    carries: num(row, "carries"),
    tacklesSolo: num(row, "def_tackles_solo"),
  };
}

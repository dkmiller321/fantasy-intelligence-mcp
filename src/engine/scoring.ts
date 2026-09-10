/**
 * Fantasy points from a stat line and a league scoring map.
 *
 * Providers ship a points field alongside the stat line, but it is scored for
 * their own default format. For IDP it is not merely off, it is meaningless: a
 * projected LB line scoring 3.30 points in this league is reported by Sleeper as
 * `pts_ppr: 0.15`. Points are therefore always recomputed here (DECISIONS D5).
 */

/** Sleeper stat keys that are metadata, not scoring events. */
const NON_SCORING_KEYS = new Set([
  "gp",
  "gms_active",
  "adp_dd_ppr",
  "pos_adp_dd_ppr",
  "pts_ppr",
  "pts_half_ppr",
  "pts_std",
  "tm_def_snp",
  "tm_off_snp",
  "tm_st_snp",
  "off_snp",
  "def_snp",
  "st_snp",
]);

export interface ScoringResult {
  points: number;
  /** Per-key contributions, largest first. Drives the `evidence` array. */
  contributions: { key: string; stat: number; perUnit: number; points: number }[];
  /** Stat keys present in the line that the league does not score. */
  ignoredKeys: string[];
}

export function scoreStatLine(
  statLine: Readonly<Record<string, number>>,
  scoring: Readonly<Record<string, number>>,
): ScoringResult {
  const contributions: ScoringResult["contributions"] = [];
  const ignoredKeys: string[] = [];
  let points = 0;

  for (const [key, stat] of Object.entries(statLine)) {
    if (NON_SCORING_KEYS.has(key)) continue;
    if (!Number.isFinite(stat) || stat === 0) continue;

    const perUnit = scoring[key];
    if (perUnit === undefined) {
      ignoredKeys.push(key);
      continue;
    }
    if (perUnit === 0) continue;

    const contribution = stat * perUnit;
    points += contribution;
    contributions.push({ key, stat, perUnit, points: contribution });
  }

  contributions.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  // Sum in float order then round once; avoids drift across ~20 stat keys.
  return { points: Math.round(points * 100) / 100, contributions, ignoredKeys };
}

/**
 * Which scoring format the league most resembles, for labelling provider
 * projections that only publish preset formats.
 */
export function inferScoringFormat(
  scoring: Readonly<Record<string, number>>,
): "ppr" | "half" | "std" {
  const rec = scoring.rec ?? 0;
  if (rec >= 0.75) return "ppr";
  if (rec >= 0.25) return "half";
  return "std";
}

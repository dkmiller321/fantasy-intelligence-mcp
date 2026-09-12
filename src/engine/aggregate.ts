import type { Position } from "../domain/types";
import { CONFIG, priorSeasonWeight } from "./config";

/** One scored week for one player. */
export interface WeekRow {
  playerId: string;
  position: Position;
  season: number;
  week: number;
  /** The defence this player scored against. */
  opponent: string | null;
  points: number;
  targetShare?: number | null;
  carries?: number | null;
  snapShare?: number | null;
}

export interface DvpRow {
  team: string;
  position: Position;
  fpaPerGame: number;
  rank: number;
  window: number;
  priorWeight: number;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Points allowed per game by each defence to each position.
 *
 * A defence's number is the total fantasy points its opponents' players at that position
 * scored, divided by games played. In week 1 the current season has no data, so this is
 * blended with the prior season on the curve in CONFIG.priorSeasonBlend (DECISIONS D7).
 *
 * The prior-season component uses that season in full rather than its last six weeks:
 * a larger sample is steadier, and six-week recency from a season that has already ended
 * carries no more signal about a reshaped roster than the full year does.
 */
export function defenseVsPosition(
  currentRows: readonly WeekRow[],
  priorRows: readonly WeekRow[],
  throughWeek: number,
): DvpRow[] {
  const priorW = priorSeasonWeight(throughWeek);

  // Season to date rather than a rolling window. A six-week window was meant to capture
  // recent form, but tested against 2025 it was slightly worse than using every game
  // played: the extra sample is worth more than the recency (DECISIONS D24).
  const current = accumulate(currentRows.filter((r) => r.week >= 1 && r.week <= throughWeek));
  const prior = accumulate(priorRows);

  const teams = new Set([...current.keys(), ...prior.keys()].map((k) => k.split("|")[0] as string));
  const positions = new Set(
    [...current.keys(), ...prior.keys()].map((k) => k.split("|")[1] as Position),
  );

  const out: DvpRow[] = [];
  for (const position of positions) {
    const perTeam: { team: string; fpa: number }[] = [];
    for (const team of teams) {
      const key = `${team}|${position}`;
      const c = current.get(key);
      const p = prior.get(key);
      const cAvg = c && c.games > 0 ? c.points / c.games : null;
      const pAvg = p && p.games > 0 ? p.points / p.games : null;

      // Blend only where both exist; otherwise use whichever side has data.
      let fpa: number | null;
      if (cAvg !== null && pAvg !== null) fpa = priorW * pAvg + (1 - priorW) * cAvg;
      else fpa = cAvg ?? pAvg;
      if (fpa === null) continue;

      perTeam.push({ team, fpa });
    }

    // Rank 1 is the most generous defence, which is the best matchup to attack.
    perTeam.sort((a, b) => b.fpa - a.fpa);
    perTeam.forEach((t, i) => {
      out.push({
        team: t.team,
        position,
        fpaPerGame: Math.round(t.fpa * 100) / 100,
        rank: i + 1,
        // Games of current-season data behind this row, which is what the prior weight
        // is a function of.
        window: throughWeek,
        priorWeight: priorW,
      });
    });
  }
  return out;
}

function accumulate(
  rows: readonly WeekRow[],
): Map<string, { points: number; games: number; weeks: Set<number> }> {
  const acc = new Map<string, { points: number; games: number; weeks: Set<number> }>();

  for (const r of rows) {
    if (!r.opponent) continue;
    const key = `${r.opponent}|${r.position}`;
    const entry = acc.get(key) ?? { points: 0, games: 0, weeks: new Set<number>() };
    entry.points += r.points;
    entry.weeks.add(r.week);
    acc.set(key, entry);
  }

  // Games played is distinct weeks the defence appeared, not player-rows.
  for (const entry of acc.values()) {
    entry.games = entry.weeks.size;
  }
  return acc;
}

/** League mean and sigma for a position, used to turn one team's fpa into a z-score. */
export function dvpDistribution(
  rows: readonly DvpRow[],
  position: Position,
): { mean: number; sigma: number } {
  const values = rows.filter((r) => r.position === position).map((r) => r.fpaPerGame);
  if (values.length === 0) return { mean: 0, sigma: 0 };
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return { mean: m, sigma: Math.sqrt(variance) };
}

export type TrendLabel = "rising" | "flat" | "falling";

export interface UsageTrend {
  playerId: string;
  metric: string;
  recent: number;
  prior: number;
  delta: number;
  label: TrendLabel;
}

/**
 * Recent window against the window before it, per SPEC section 8. With fewer than two
 * windows of data the trend is reported flat rather than invented.
 */
export function usageTrend(
  playerId: string,
  metric: string,
  weeklyValues: readonly { week: number; value: number }[],
  throughWeek: number,
): UsageTrend | null {
  const w = CONFIG.usage.windowWeeks;
  const recentStart = throughWeek - w + 1;
  const priorStart = recentStart - w;

  const recentVals = weeklyValues
    .filter((v) => v.week >= recentStart && v.week <= throughWeek)
    .map((v) => v.value);
  const priorVals = weeklyValues
    .filter((v) => v.week >= priorStart && v.week < recentStart)
    .map((v) => v.value);

  if (recentVals.length === 0 || priorVals.length === 0) return null;

  const recent = mean(recentVals);
  const prior = mean(priorVals);
  const delta = recent - prior;
  const label: TrendLabel =
    delta > CONFIG.usage.risingThreshold
      ? "rising"
      : delta < -CONFIG.usage.risingThreshold
        ? "falling"
        : "flat";

  return {
    playerId,
    metric,
    recent: Math.round(recent * 1000) / 1000,
    prior: Math.round(prior * 1000) / 1000,
    delta: Math.round(delta * 1000) / 1000,
    label,
  };
}

/** Position-level sigma, the fallback band for players with too little history. */
export function positionSigma(rows: readonly WeekRow[], position: Position): number {
  const values = rows.filter((r) => r.position === position && r.points > 0).map((r) => r.points);
  if (values.length < 2) return 4;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

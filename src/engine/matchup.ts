/**
 * Head-to-head win probability and playoff schedule difficulty.
 */

export interface TeamProjection {
  /** Expected points from the starting lineup. */
  mean: number;
  /** Standard deviation of that total. */
  sigma: number;
}

/**
 * Treat each team's weekly total as normal and take the probability that the difference
 * favours us. Fantasy scores are not truly normal, but with a dozen-odd independent
 * starters the sum is close enough, and the alternative is a simulation the CPU budget
 * cannot afford.
 */
export function winProbability(mine: TeamProjection, theirs: TeamProjection): number {
  const meanDiff = mine.mean - theirs.mean;
  const sigmaDiff = Math.sqrt(mine.sigma ** 2 + theirs.sigma ** 2);
  if (sigmaDiff <= 0) return meanDiff > 0 ? 1 : meanDiff < 0 ? 0 : 0.5;
  return normalCdf(meanDiff / sigmaDiff);
}

/** Abramowitz and Stegun 7.1.26; accurate to about 1e-7, which is far beyond need here. */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Combined sigma for a lineup. Individual floors and ceilings give a per-player band;
 * treating starters as independent understates correlation slightly (a stack rises
 * together) but is the right default without play-by-play modelling.
 */
export function lineupSigma(bands: readonly { floor: number; ceiling: number }[]): number {
  const variances = bands.map((b) => ((b.ceiling - b.floor) / 2) ** 2);
  return Math.sqrt(variances.reduce((a, b) => a + b, 0));
}

/** Players whose outcome moves the match most: high variance and a close projection. */
export function swingPlayers<T extends { name: string; floor: number; ceiling: number }>(
  players: readonly T[],
  limit = 3,
): T[] {
  return [...players].sort((a, b) => b.ceiling - b.floor - (a.ceiling - a.floor)).slice(0, limit);
}

export interface PlayoffWeekOutlook {
  week: number;
  opponent: string | null;
  /** 1 is the most generous defence to this position, so a low rank is a good matchup. */
  rank: number | null;
  /** 0-1, where 1 is the easiest schedule. */
  percentile: number | null;
  onBye: boolean;
}

export interface PlayerPlayoffOutlook {
  canonicalId: string;
  name: string;
  position: string;
  weeks: PlayoffWeekOutlook[];
  /** Mean percentile across playable playoff weeks; null when none are known. */
  score: number | null;
  byeConflicts: number[];
}

export function playoffOutlook(
  player: {
    canonicalId: string;
    name: string;
    position: string;
    team: string | null;
    byeWeek: number | null;
  },
  playoffWeeks: readonly number[],
  opponentFor: (team: string, week: number) => string | null,
  rankFor: (opponent: string, position: string) => number | null,
  teamsInLeague: number,
): PlayerPlayoffOutlook {
  const weeks: PlayoffWeekOutlook[] = [];
  const byeConflicts: number[] = [];

  for (const week of playoffWeeks) {
    const onBye = player.byeWeek === week;
    if (onBye) byeConflicts.push(week);

    const opponent = player.team ? opponentFor(player.team, week) : null;
    const rank = opponent ? rankFor(opponent, player.position) : null;
    weeks.push({
      week,
      opponent,
      rank,
      // Rank 1 is most generous, so percentile 1 means the easiest matchup.
      percentile: rank === null ? null : 1 - (rank - 1) / Math.max(1, teamsInLeague - 1),
      onBye,
    });
  }

  const scored = weeks.filter((w) => !w.onBye && w.percentile !== null);
  const score =
    scored.length > 0
      ? Math.round(
          (scored.reduce((a, w) => a + (w.percentile as number), 0) / scored.length) * 100,
        ) / 100
      : null;

  return {
    canonicalId: player.canonicalId,
    name: player.name,
    position: player.position,
    weeks,
    score,
    byeConflicts,
  };
}

/**
 * What a player has actually done, as opposed to what someone projects them to do.
 *
 * A projection is a single number with no shape. "Projected 13.2" and "has cleared 13 in
 * four of his last six, with a floor of 6" are the same expectation and very different
 * decisions. This turns the stored game log into the second kind of statement
 * (DECISIONS D29).
 */

export type ConsistencyLabel = "steady" | "volatile" | "boom or bust" | "thin sample";

export interface ScoringHistory {
  games: number;
  /** Actual points scored, oldest first. */
  scores: number[];
  median: number;
  /** Lower and upper quartiles of real games, which is a floor and ceiling that happened. */
  floor: number;
  ceiling: number;
  /** Share of games at or above the number being projected for this week. */
  hitRate: number | null;
  label: ConsistencyLabel;
  /** One sentence a reader can act on, or null with too little history. */
  summary: string | null;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoringHistory(
  scores: readonly number[],
  projection: number | null,
  name: string,
): ScoringHistory {
  const games = scores.length;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = round1(quantile(sorted, 0.5));
  const floor = round1(quantile(sorted, 0.25));
  const ceiling = round1(quantile(sorted, 0.75));

  // Fewer than four games says very little, and saying it anyway is how a projection
  // acquires false authority.
  if (games < 4) {
    return {
      games,
      scores: [...scores],
      median,
      floor,
      ceiling,
      hitRate: null,
      label: "thin sample",
      summary:
        games === 0
          ? null
          : `Only ${games} scored ${games === 1 ? "game" : "games"} on record for ${name}, too few to describe a range.`,
    };
  }

  const hits = projection !== null ? scores.filter((s) => s >= projection).length : 0;
  const hitRate = projection !== null ? hits / games : null;

  // Spread relative to the player's own level, so a 20-point back and a 6-point
  // linebacker are judged on the same scale.
  const spread = median > 0 ? (ceiling - floor) / median : 0;
  const label: ConsistencyLabel =
    spread < 0.6 ? "steady" : spread < 1.2 ? "volatile" : "boom or bust";

  const parts = [
    `${name} has scored between ${floor} and ${ceiling} in the middle half of his last ${games} games, median ${median}`,
  ];
  if (projection !== null && hitRate !== null) {
    parts.push(
      `and reached this week's ${round1(projection)} in ${hits} of ${games} (${Math.round(hitRate * 100)}%)`,
    );
  }
  const shape =
    label === "steady"
      ? "His weekly range is tight, so the projection is a fair expectation"
      : label === "volatile"
        ? "His weekly range is wide, so treat the projection as a midpoint rather than a forecast"
        : "He is boom or bust: the median understates the good weeks and overstates the bad ones";

  return {
    games,
    scores: [...scores],
    median,
    floor,
    ceiling,
    hitRate,
    label,
    summary: `${parts.join(", ")}. ${shape}.`,
  };
}

export type DivergenceSignal =
  | "volume ahead of production"
  | "production ahead of volume"
  | "aligned"
  | "unknown";

export interface UsageDivergence {
  signal: DivergenceSignal;
  note: string | null;
}

/**
 * Whether the opportunity and the output agree.
 *
 * A player whose snap share is climbing while his scoring is flat is getting the chances
 * without the results yet, which is the cheapest kind of upside to buy. The reverse — a
 * big number on shrinking usage — usually means a touchdown that will not repeat. Neither
 * is visible in a projection, which reports the expectation and not the tension behind it.
 */
export function usageDivergence(
  snapTrend: { label: string; delta: number } | null,
  pointsTrend: { label: string; delta: number } | null,
  name: string,
): UsageDivergence {
  if (!snapTrend || !pointsTrend) return { signal: "unknown", note: null };

  if (snapTrend.label === "rising" && pointsTrend.label !== "rising") {
    return {
      signal: "volume ahead of production",
      note: `${name} is playing more snaps without the scoring following yet. The chances are there; buy before the results are.`,
    };
  }
  if (pointsTrend.label === "rising" && snapTrend.label === "falling") {
    return {
      signal: "production ahead of volume",
      note: `${name} is scoring more on fewer snaps, which usually means touchdowns that will not repeat at that rate.`,
    };
  }
  return { signal: "aligned", note: null };
}

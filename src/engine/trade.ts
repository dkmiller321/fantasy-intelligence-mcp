import type { Position } from "../domain/types";
import { CONFIG, clamp } from "./config";

/**
 * Trade valuation: value over replacement, weighted toward the playoff weeks, with a
 * dynasty age adjustment.
 *
 * SPEC section 13 excludes dynasty valuation, but this league is dynasty with a taxi
 * squad, so pure rest-of-season value systematically undervalues young players
 * (DECISIONS D8). Rookie draft picks are still not valued: there is no keyless,
 * ToS-clean source for pick values, and inventing a table would be worse than declining.
 */

export interface TradeAsset {
  canonicalId: string;
  name: string;
  position: Position;
  /** Projected points per remaining game. */
  pointsPerGame: number;
  age: number | null;
  /** Best freely available player at this position, in points per game. */
  replacementPpg: number;
}

export interface ValuedAsset extends TradeAsset {
  valueOverReplacement: number;
  ageMultiplier: number;
  adjustedValue: number;
}

/**
 * Age adjustment. Below the positional peak a player earns a modest premium for the
 * seasons still ahead of them; beyond it, value decays at a per-position rate. Capped so
 * age can shade a verdict but never invert a large on-field gap.
 */
export function ageMultiplier(position: Position, age: number | null): number {
  if (age === null) return 1;
  const curve = CONFIG.trade.ageCurve[position];
  if (!curve) return 1;

  const delta = age - curve.peak;
  const raw =
    delta > 0
      ? -delta * curve.declinePerYear
      : Math.min(-delta * CONFIG.trade.youthPremiumPerYear, CONFIG.trade.maxAgeAdjustment);

  return 1 + clamp(raw, -CONFIG.trade.maxAgeAdjustment, CONFIG.trade.maxAgeAdjustment);
}

export function valueAsset(
  asset: TradeAsset,
  remainingWeeks: number,
  playoffWeeks: number,
): ValuedAsset {
  const vor = asset.pointsPerGame - asset.replacementPpg;
  // Playoff weeks decide the season, so they count for more than a week-4 win.
  const regularWeeks = Math.max(0, remainingWeeks - playoffWeeks);
  const weighted = vor * regularWeeks + vor * playoffWeeks * CONFIG.trade.playoffWeekMultiplier;

  const mult = ageMultiplier(asset.position, asset.age);
  return {
    ...asset,
    valueOverReplacement: Math.round(vor * 100) / 100,
    ageMultiplier: Math.round(mult * 100) / 100,
    adjustedValue: Math.round(weighted * mult * 10) / 10,
  };
}

export interface TradeSide {
  assets: ValuedAsset[];
  total: number;
}

export interface TradeVerdict {
  give: TradeSide;
  receive: TradeSide;
  net: number;
  /** Positive favours the owner. */
  verdict: "accept" | "lean accept" | "close" | "lean decline" | "decline";
  rosterFitNote: string | null;
}

function sideOf(assets: readonly ValuedAsset[]): TradeSide {
  return {
    assets: [...assets],
    total: Math.round(assets.reduce((a, b) => a + b.adjustedValue, 0) * 10) / 10,
  };
}

/**
 * Uneven trades count the extra bodies at replacement level: a two-for-one only helps if
 * the consolidated player clears what the roster spot would otherwise hold.
 */
export function evaluateTrade(
  give: readonly ValuedAsset[],
  receive: readonly ValuedAsset[],
): TradeVerdict {
  const giveSide = sideOf(give);
  const receiveSide = sideOf(receive);
  const net = Math.round((receiveSide.total - giveSide.total) * 10) / 10;

  const scale = Math.max(50, Math.abs(giveSide.total), Math.abs(receiveSide.total));
  const ratio = net / scale;

  const verdict: TradeVerdict["verdict"] =
    ratio > 0.15
      ? "accept"
      : ratio > 0.05
        ? "lean accept"
        : ratio < -0.15
          ? "decline"
          : ratio < -0.05
            ? "lean decline"
            : "close";

  let rosterFitNote: string | null = null;
  if (receive.length < give.length) {
    rosterFitNote =
      `Consolidating ${give.length} players into ${receive.length} frees roster spots but ` +
      "leaves fewer startable bodies; the difference is counted at replacement level.";
  } else if (receive.length > give.length) {
    rosterFitNote =
      `Taking back ${receive.length} for ${give.length} needs roster room, and the extra ` +
      "players are only worth what they beat on the waiver wire.";
  }

  return { give: giveSide, receive: receiveSide, net, verdict, rosterFitNote };
}

export interface WaiverCandidate {
  canonicalId: string;
  name: string;
  position: Position;
  /** Rest-of-season points per game, normalized 0-1 against the position's best free agent. */
  rosValue: number;
  /** -1 to 1. */
  usageTrend: number;
  /** 0-1: teammate injury, depth chart move, or a spike in adds. */
  opportunity: number;
  trendingAdds: number;
}

export interface ScoredWaiver extends WaiverCandidate {
  score: number;
  faabLow: number;
  faabHigh: number;
}

export function scoreWaiver(c: WaiverCandidate, maxTrendingAdds: number): ScoredWaiver {
  const w = CONFIG.waivers;
  const trendingBoost = maxTrendingAdds > 0 ? c.trendingAdds / maxTrendingAdds : 0;

  const base =
    w.rosValueWeight * clamp(c.rosValue, 0, 1) +
    w.usageTrendWeight * clamp((c.usageTrend + 1) / 2, 0, 1) +
    w.opportunityWeight * clamp(c.opportunity, 0, 1);

  // Trending adds are a crowd signal, not an analytical one, so they nudge rather than
  // drive; they also tell you what a bid will have to beat.
  const score = clamp(base * 0.85 + trendingBoost * 0.15, 0, 1);
  const band = w.faabBands.find((b) => score >= b.minScore) ?? w.faabBands[w.faabBands.length - 1];

  return {
    ...c,
    score: Math.round(score * 100) / 100,
    faabLow: band?.low ?? 1,
    faabHigh: band?.high ?? 3,
  };
}

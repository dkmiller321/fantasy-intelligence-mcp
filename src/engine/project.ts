import type { Evidence, InjuryStatus, Position } from "../domain/types";
import { CONFIG, clamp } from "./config";

/** One provider's view of a player's week. */
export interface SourceProjection {
  source: string;
  points: number;
  floor?: number;
  ceiling?: number;
}

export interface Consensus {
  points: number;
  sources: string[];
  /** 0-1; 1 when sources agree exactly, falling as they diverge. */
  agreement: number;
}

/**
 * Weighted mean of the available sources. A single source takes full weight but caps
 * confidence downstream (SPEC section 8).
 */
export function consensusProjection(sources: readonly SourceProjection[]): Consensus | null {
  if (sources.length === 0) return null;
  if (sources.length === 1) {
    const only = sources[0] as SourceProjection;
    return { points: only.points, sources: [only.source], agreement: 1 };
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const s of sources) {
    const w = CONFIG.sourceWeights[s.source] ?? 0.3;
    weighted += s.points * w;
    totalWeight += w;
  }
  const points = totalWeight > 0 ? weighted / totalWeight : 0;

  // Agreement falls as the spread widens relative to the mean.
  const values = sources.map((s) => s.points);
  const spread = Math.max(...values) - Math.min(...values);
  const agreement = points > 0 ? clamp(1 - spread / (points * 2), 0, 1) : 0;

  return { points, sources: sources.map((s) => s.source), agreement };
}

export interface Range {
  floor: number;
  ceiling: number;
  /** How the band was derived, for the caveat text. */
  basis: "source" | "history" | "position";
}

/**
 * Floor and ceiling. Provider bands win when present; otherwise one standard deviation
 * of the player's recent weeks, falling back to a position-level sigma when the player
 * has too little history.
 */
export function projectionRange(
  consensus: number,
  sources: readonly SourceProjection[],
  recentPoints: readonly number[],
  positionSigma: number,
): Range {
  const withBands = sources.filter((s) => s.floor !== undefined && s.ceiling !== undefined);
  if (withBands.length > 0) {
    const floor = withBands.reduce((a, s) => a + (s.floor as number), 0) / withBands.length;
    const ceiling = withBands.reduce((a, s) => a + (s.ceiling as number), 0) / withBands.length;
    return { floor, ceiling, basis: "source" };
  }

  const sample = recentPoints.slice(-CONFIG.range.lookbackWeeks);
  if (sample.length >= CONFIG.range.minGames) {
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
    const sigma = Math.sqrt(variance);
    return { floor: Math.max(0, consensus - sigma), ceiling: consensus + sigma, basis: "history" };
  }

  return {
    floor: Math.max(0, consensus - positionSigma),
    ceiling: consensus + positionSigma,
    basis: "position",
  };
}

/**
 * Matchup multiplier from how generous the opponent has been to this position.
 * `fpaPerGame` is the opponent's points allowed; league mean and sigma come from the
 * materialized defense_vs_position rows.
 */
export function matchupMultiplier(
  fpaPerGame: number | null,
  leagueMean: number,
  leagueSigma: number,
): { multiplier: number; z: number } {
  if (fpaPerGame === null || leagueSigma <= 0) return { multiplier: 1, z: 0 };
  const z = (fpaPerGame - leagueMean) / leagueSigma;
  const multiplier = clamp(1 + z * CONFIG.matchup.perZ, CONFIG.matchup.min, CONFIG.matchup.max);
  return { multiplier, z };
}

export interface GameEnvironment {
  impliedTeamTotal: number | null;
  roof: string | null;
  windMph: number | null;
  precipProb: number | null;
}

/**
 * Environment multiplier: implied team total against the league mean, then weather
 * penalties for outdoor games only.
 */
export function environmentMultiplier(
  env: GameEnvironment,
  position: Position,
  leagueMeanTotal: number,
  leagueSigmaTotal: number,
): { multiplier: number; notes: string[] } {
  const notes: string[] = [];
  let multiplier = 1;

  if (env.impliedTeamTotal !== null && leagueSigmaTotal > 0) {
    const z = (env.impliedTeamTotal - leagueMeanTotal) / leagueSigmaTotal;
    multiplier = clamp(
      1 + z * CONFIG.environment.perZ,
      CONFIG.environment.min,
      CONFIG.environment.max,
    );
    notes.push(`implied team total ${env.impliedTeamTotal.toFixed(1)}`);
  }

  const outdoor = env.roof === "outdoors" || env.roof === "open";
  if (outdoor) {
    const affected = (CONFIG.environment.windAffects as readonly string[]).includes(position);
    if (affected && env.windMph !== null && env.windMph >= CONFIG.environment.windThresholdMph) {
      multiplier *= CONFIG.environment.windMultiplier;
      notes.push(`wind ${Math.round(env.windMph)} mph`);
    }
    if (env.precipProb !== null && env.precipProb >= CONFIG.environment.precipThreshold) {
      multiplier *= CONFIG.environment.precipMultiplier;
      notes.push(`precipitation ${Math.round(env.precipProb * 100)}%`);
    }
  } else if (env.roof) {
    notes.push(env.roof);
  }

  return { multiplier, notes };
}

export function isExcludedByInjury(status: InjuryStatus): boolean {
  return (CONFIG.injury.excluded as readonly string[]).includes(status);
}

export function injuryMultiplier(status: InjuryStatus): number {
  if (isExcludedByInjury(status)) return 0;
  if (status === "questionable") return CONFIG.injury.questionableMultiplier;
  return 1;
}

export interface CompositeInput {
  consensus: Consensus;
  matchup: { multiplier: number; z: number };
  environment: { multiplier: number; notes: string[] };
  injuryStatus: InjuryStatus;
  opponent: string | null;
}

export interface Composite {
  points: number;
  evidence: Evidence[];
}

/**
 * consensus x matchup x environment x injury, with each factor's contribution reported
 * so the LLM can explain the number and overrule it with context the server lacks.
 */
export function composite(input: CompositeInput): Composite {
  const { consensus, matchup, environment, injuryStatus, opponent } = input;
  const injury = injuryMultiplier(injuryStatus);
  const points = consensus.points * matchup.multiplier * environment.multiplier * injury;

  const evidence: Evidence[] = [
    {
      factor: "consensus projection",
      value: round1(consensus.points),
      effect: "0",
      note:
        consensus.sources.length === 1
          ? `single source (${consensus.sources[0]})`
          : `${consensus.sources.length} sources`,
    },
  ];

  if (matchup.multiplier !== 1) {
    evidence.push({
      factor: "matchup",
      value: `x${matchup.multiplier.toFixed(2)}`,
      effect: matchup.multiplier > 1 ? "+" : "-",
      note: opponent
        ? `vs ${opponent}, ${matchup.z > 0 ? "generous" : "stingy"} to this position`
        : undefined,
    });
  }

  if (environment.multiplier !== 1) {
    evidence.push({
      factor: "game environment",
      value: `x${environment.multiplier.toFixed(2)}`,
      effect: environment.multiplier > 1 ? "+" : "-",
      note: environment.notes.join(", ") || undefined,
    });
  }

  if (injury !== 1) {
    evidence.push({
      factor: "injury",
      value: injury === 0 ? "ineligible" : `x${injury.toFixed(2)}`,
      effect: "-",
      note: injuryStatus,
    });
  }

  return { points, evidence };
}

/**
 * Confidence in a recommendation. SPEC section 8:
 * 0.5 + 0.2 agreement + 0.2 gap - 0.15 injury - 0.10 missing sources.
 */
export function confidence(input: {
  sourceAgreement: number;
  /** Normalized 0-1 gap between the leading candidate and the runner-up. */
  projectionGap: number;
  injuryUncertain: boolean;
  missingSources: number;
  singleSource: boolean;
}): number {
  const c = CONFIG.confidence;
  let value =
    c.base +
    c.sourceAgreement * clamp(input.sourceAgreement, 0, 1) +
    c.projectionGap * clamp(input.projectionGap, 0, 1) -
    (input.injuryUncertain ? c.injuryUncertainty : 0) -
    c.missingSources * clamp(input.missingSources, 0, 1);

  value = clamp(value, c.min, c.max);
  if (input.singleSource) value = Math.min(value, CONFIG.singleSourceConfidenceCap);
  return Math.round(value * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

import type { Evidence, InjuryStatus, Position } from "../domain/types";
import { positionSigma as defaultSigma } from "../engine/aggregate";
import { CONFIG } from "../engine/config";
import {
  composite,
  confidence,
  consensusProjection,
  environmentMultiplier,
  injuryMultiplier,
  isExcludedByInjury,
  matchupMultiplier,
  projectionRange,
  type SourceProjection,
} from "../engine/project";
import { AnalyticsRepo, type GameRow, indexDvp, indexGames } from "../storage/d1/analytics";
import type { PlayerRow } from "../storage/d1/players";

export interface EvaluatedPlayer {
  canonicalId: string;
  name: string;
  position: Position;
  fantasyPositions: Position[];
  team: string | null;
  opponent: string | null;
  isHome: boolean | null;
  injury: InjuryStatus;
  injuryNote: string | null;
  /** Final number after every factor. Null when no projection exists at all. */
  points: number | null;
  consensusPoints: number | null;
  floor: number | null;
  ceiling: number | null;
  rangeBasis: string | null;
  matchupRank: number | null;
  matchupFpa: number | null;
  impliedTeamTotal: number | null;
  roof: string | null;
  kickoff: string | null;
  eligible: boolean;
  sources: string[];
  sourceAgreement: number;
  trend: { metric: string; label: string; delta: number }[];
  recentPoints: number[];
  evidence: Evidence[];
}

export interface EvaluationContext {
  season: number;
  week: number;
  /** Blend weight actually used by the materialized DvP rows, for the caveat text. */
  priorWeight: number;
  /** Players with no projection row at all. */
  missingProjections: string[];
  games: GameRow[];
}

export interface EvaluationResult {
  players: EvaluatedPlayer[];
  context: EvaluationContext;
}

/**
 * Turn stored rows into fully-factored projections. Everything expensive was
 * precomputed; this does a handful of multiplications per player.
 */
export async function evaluatePlayers(
  db: D1Database,
  rows: readonly PlayerRow[],
  season: number,
  week: number,
): Promise<EvaluationResult> {
  const analytics = new AnalyticsRepo(db);
  const ids = rows.map((r) => r.canonical_id);

  const [projections, dvpRows, gameRows, recent, trends] = await Promise.all([
    analytics.projections(ids, season, week),
    analytics.defenseVsPosition(season, week),
    analytics.games(season, week),
    analytics.recentPoints(ids, season, week, season - 1),
    analytics.usageTrends(ids, season, week),
  ]);

  const dvp = indexDvp(dvpRows);
  const games = indexGames(gameRows);
  const priorWeight = dvpRows[0]?.prior_weight ?? 0;

  // League-wide implied-total distribution for the environment z-score.
  const totals = gameRows
    .flatMap((g) => [g.implied_home, g.implied_away])
    .filter((t): t is number => t !== null);
  const totalMean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  const totalSigma = totals.length
    ? Math.sqrt(totals.reduce((a, b) => a + (b - totalMean) ** 2, 0) / totals.length)
    : 0;

  const missingProjections: string[] = [];
  const players: EvaluatedPlayer[] = [];

  for (const row of rows) {
    const position = row.position as Position;
    const fantasyPositions = JSON.parse(row.fantasy_positions) as Position[];
    const injury = (row.injury_status ?? "healthy") as InjuryStatus;
    const slate = row.team ? games.get(row.team) : undefined;
    const opponent = slate?.opponent ?? null;

    const sources: SourceProjection[] = (projections.get(row.canonical_id) ?? []).map((p) => ({
      source: p.source,
      points: p.points,
      ...(p.floor !== null ? { floor: p.floor } : {}),
      ...(p.ceiling !== null ? { ceiling: p.ceiling } : {}),
    }));

    const history = recent.get(row.canonical_id) ?? [];
    const consensus = consensusProjection(sources);

    if (!consensus) {
      missingProjections.push(row.name);
      players.push({
        canonicalId: row.canonical_id,
        name: row.name,
        position,
        fantasyPositions,
        team: row.team,
        opponent,
        isHome: slate?.isHome ?? null,
        injury,
        injuryNote: row.injury_body_part,
        // With no projection, the player's own trailing average is the honest fallback.
        points: history.length > 0 ? trailingAverage(history) : null,
        consensusPoints: null,
        floor: null,
        ceiling: null,
        rangeBasis: history.length > 0 ? "trailing average" : null,
        matchupRank: dvp.get(opponent, position)?.rank ?? null,
        matchupFpa: dvp.get(opponent, position)?.fpa_per_game ?? null,
        impliedTeamTotal: slate?.impliedTotal ?? null,
        roof: slate?.game.roof ?? null,
        kickoff: slate?.game.kickoff ?? null,
        eligible: !isExcludedByInjury(injury),
        sources: [],
        sourceAgreement: 0,
        trend: trends.get(row.canonical_id) ?? [],
        recentPoints: history.slice(-6),
        evidence: [
          {
            factor: "no projection available",
            value: history.length > 0 ? `trailing avg ${round1(trailingAverage(history))}` : "none",
            effect: "0",
            note: "no provider projected this player for this week",
          },
        ],
      });
      continue;
    }

    const dvpRow = dvp.get(opponent, position);
    const dist = dvp.distribution(position);
    const matchup = matchupMultiplier(dvpRow?.fpa_per_game ?? null, dist.mean, dist.sigma);

    const environment = environmentMultiplier(
      {
        impliedTeamTotal: slate?.impliedTotal ?? null,
        roof: slate?.game.roof ?? null,
        windMph: slate?.game.wind_mph ?? null,
        precipProb: slate?.game.precip_prob ?? null,
      },
      position,
      totalMean,
      totalSigma,
    );

    const comp = composite({ consensus, matchup, environment, injuryStatus: injury, opponent });
    const range = projectionRange(comp.points, sources, history, defaultSigma([], position) || 4);
    const widen = injury === "questionable" ? CONFIG.injury.questionableRangeWiden : 1;

    players.push({
      canonicalId: row.canonical_id,
      name: row.name,
      position,
      fantasyPositions,
      team: row.team,
      opponent,
      isHome: slate?.isHome ?? null,
      injury,
      injuryNote: row.injury_body_part,
      points: comp.points,
      consensusPoints: consensus.points,
      floor: Math.max(0, comp.points - (comp.points - range.floor) * widen),
      ceiling: comp.points + (range.ceiling - comp.points) * widen,
      rangeBasis: range.basis,
      matchupRank: dvpRow?.rank ?? null,
      matchupFpa: dvpRow?.fpa_per_game ?? null,
      impliedTeamTotal: slate?.impliedTotal ?? null,
      roof: slate?.game.roof ?? null,
      kickoff: slate?.game.kickoff ?? null,
      eligible: injuryMultiplier(injury) > 0,
      sources: consensus.sources,
      sourceAgreement: consensus.agreement,
      trend: trends.get(row.canonical_id) ?? [],
      recentPoints: history.slice(-6),
      evidence: comp.evidence,
    });
  }

  return {
    players,
    context: { season, week, priorWeight, missingProjections, games: gameRows },
  };
}

function trailingAverage(points: readonly number[]): number {
  const sample = points.slice(-4);
  return Math.round((sample.reduce((a, b) => a + b, 0) / sample.length) * 10) / 10;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Caveats every projection-based tool should carry, given what was and was not found. */
export function evaluationCaveats(result: EvaluationResult): string[] {
  const caveats: string[] = [];
  const { context, players } = result;

  if (context.priorWeight >= 0.999) {
    caveats.push(
      `Week ${context.week}: matchup grades come entirely from ${context.season - 1} data, ` +
        "because this season has no games yet. They describe last year's defences.",
    );
  } else if (context.priorWeight > 0) {
    caveats.push(
      `Matchup grades blend ${Math.round(context.priorWeight * 100)}% ${context.season - 1} ` +
        `data with ${Math.round((1 - context.priorWeight) * 100)}% this season.`,
    );
  }

  if (context.missingProjections.length > 0) {
    const names = context.missingProjections.slice(0, 6).join(", ");
    const more =
      context.missingProjections.length > 6
        ? ` and ${context.missingProjections.length - 6} more`
        : "";
    caveats.push(
      `No projection was published for ${names}${more}; their trailing average is used ` +
        "where history exists, and confidence is reduced.",
    );
  }

  // Coverage is uneven by design: ESPN's public league has no defensive slots, so IDP is
  // single-source while offence is not. Saying "single source" flatly would misdescribe
  // half the roster in either direction (DECISIONS D20).
  const single = players.filter((p) => p.points !== null && p.sources.length === 1);
  if (single.length > 0) {
    const idp = single.filter((p) => ["DL", "LB", "DB"].includes(p.position));
    const offence = single.filter((p) => !["DL", "LB", "DB"].includes(p.position));

    if (idp.length > 0) {
      caveats.push(
        `IDP projections come from Sleeper alone, because no free source covers defensive ` +
          `players. Confidence for ${idp
            .map((p) => p.name)
            .slice(0, 5)
            .join(", ")}` +
          `${idp.length > 5 ? ` and ${idp.length - 5} others` : ""} is capped at ` +
          `${CONFIG.singleSourceConfidenceCap}.`,
      );
    }
    if (offence.length > 0) {
      caveats.push(
        `${offence.length} offensive players have only one projection source this week, ` +
          `so their confidence is capped at ${CONFIG.singleSourceConfidenceCap}.`,
      );
    }
  }

  const blended = players.filter((p) => p.sources.length > 1);
  if (blended.length > 0) {
    caveats.push(
      `${blended.length} players have projections blended from ` +
        `${[...new Set(blended.flatMap((p) => p.sources))].sort().join(" and ")}.`,
    );
  }

  const noOdds = players.some((p) => p.team && p.impliedTeamTotal === null);
  if (noOdds) {
    caveats.push(
      "Betting lines are not yet posted for some games, so game environment is neutral there.",
    );
  }

  return caveats;
}

/** Confidence for a head-to-head or slot decision. */
export function decisionConfidence(
  leader: EvaluatedPlayer,
  runnerUp: EvaluatedPlayer | null,
): number {
  const gap =
    runnerUp && leader.points !== null && runnerUp.points !== null && leader.points > 0
      ? Math.min(1, (leader.points - runnerUp.points) / leader.points)
      : 0.5;

  return confidence({
    sourceAgreement: leader.sourceAgreement,
    projectionGap: gap,
    injuryUncertain:
      leader.injury === "questionable" || runnerUp?.injury === "questionable" || false,
    missingSources: leader.consensusPoints === null ? 1 : 0,
    singleSource: leader.sources.length <= 1,
  });
}

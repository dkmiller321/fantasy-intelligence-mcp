import type { Position } from "../domain/types";
import { canFill, slotsByScarcity } from "./slots";

export interface LineupCandidate {
  canonicalId: string;
  name: string;
  position: Position;
  fantasyPositions: Position[];
  points: number | null;
  eligible: boolean;
}

export interface SlotAssignment {
  slot: string;
  player: LineupCandidate | null;
  runnerUp: LineupCandidate | null;
  /** Points the starter beats the best remaining alternative by. */
  margin: number | null;
}

export interface LineupResult {
  assignments: SlotAssignment[];
  bench: LineupCandidate[];
  projectedTotal: number;
  unfilledSlots: string[];
}

/**
 * Fill each starting slot with the best available player.
 *
 * Slots are filled most-constrained-first so a scarce slot (K, QB) claims its only
 * candidate before a flex can absorb them. This is greedy rather than a full assignment
 * search: with 18 slots and ~30 candidates an optimal solve is possible, but the greedy
 * order is what a manager actually reasons about, and it keeps the request inside the
 * 10 ms CPU budget. Where a flex choice is close, the runner-up and margin are reported
 * so the caller can see it was close.
 */
export function optimizeLineup(
  rosterPositions: readonly string[],
  candidates: readonly LineupCandidate[],
): LineupResult {
  const starting = rosterPositions.filter((s) => !["BN", "TAXI", "IR"].includes(s.toUpperCase()));
  const order = slotsByScarcity(starting);

  const available = candidates.filter((c) => c.eligible && c.points !== null);
  const used = new Set<string>();
  const bySlot = new Map<string, SlotAssignment>();

  for (const slot of order) {
    const pool = available
      .filter((c) => !used.has(c.canonicalId) && canFill(slot, c.fantasyPositions))
      .sort((a, b) => (b.points as number) - (a.points as number));

    const pick = pool[0] ?? null;
    const next = pool[1] ?? null;
    if (pick) used.add(pick.canonicalId);

    // Several identical slot names (three FLEX, four IDP_FLEX) each get their own entry.
    const key = `${slot}#${[...bySlot.keys()].filter((k) => k.startsWith(`${slot}#`)).length}`;
    bySlot.set(key, {
      slot,
      player: pick,
      runnerUp: next,
      margin:
        pick && next && pick.points !== null && next.points !== null
          ? Math.round((pick.points - next.points) * 10) / 10
          : null,
    });
  }

  // Report in roster order rather than the scarcity order used to solve.
  const assignments: SlotAssignment[] = [];
  const counts = new Map<string, number>();
  for (const slot of starting) {
    const n = counts.get(slot) ?? 0;
    counts.set(slot, n + 1);
    const found = bySlot.get(`${slot}#${n}`);
    if (found) assignments.push(found);
  }

  const bench = candidates.filter((c) => !used.has(c.canonicalId));
  const projectedTotal = assignments.reduce((a, s) => a + (s.player?.points ?? 0), 0);

  return {
    assignments,
    bench,
    projectedTotal: Math.round(projectedTotal * 10) / 10,
    unfilledSlots: assignments.filter((a) => !a.player).map((a) => a.slot),
  };
}

/** Which starters differ between the lineup currently set and the optimal one. */
export function lineupDelta(
  current: readonly string[],
  optimal: LineupResult,
): { benchToStart: LineupCandidate[]; startToBench: string[] } {
  const currentSet = new Set(current.filter((id) => id && id !== "0"));
  const optimalIds = new Set(
    optimal.assignments.map((a) => a.player?.canonicalId).filter((x): x is string => !!x),
  );

  return {
    benchToStart: optimal.assignments
      .map((a) => a.player)
      .filter((p): p is LineupCandidate => !!p && !currentSet.has(p.canonicalId)),
    startToBench: [...currentSet].filter((id) => !optimalIds.has(id)),
  };
}

import type { Position } from "../domain/types";

/**
 * Which fantasy positions may fill each Sleeper roster slot.
 * This league uses REC_FLEX and four IDP_FLEX slots, so the flex table is not
 * the usual offense-only one (DECISIONS D4).
 */
const SLOT_ELIGIBILITY: Record<string, readonly Position[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  DL: ["DL"],
  LB: ["LB"],
  DB: ["DB"],
  FLEX: ["RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

/** Slots that never hold a starter. */
const NON_STARTING = new Set(["BN", "TAXI", "IR"]);

export function isStartingSlot(slot: string): boolean {
  return !NON_STARTING.has(slot.toUpperCase());
}

export function eligiblePositions(slot: string): readonly Position[] {
  return SLOT_ELIGIBILITY[slot.toUpperCase()] ?? [];
}

/**
 * A player fills a slot if any of their fantasy positions is eligible. Sleeper's
 * `fantasy_positions` is multi-valued for hybrids (Von Miller: DL and LB), so
 * eligibility must consider every entry, not just the primary position.
 */
export function canFill(slot: string, fantasyPositions: readonly Position[]): boolean {
  const allowed = eligiblePositions(slot);
  return fantasyPositions.some((p) => allowed.includes(p));
}

/** Starting slots in roster order, bench and taxi removed. */
export function startingSlots(rosterPositions: readonly string[]): string[] {
  return rosterPositions.filter(isStartingSlot);
}

/**
 * Slots ordered most constrained first, so a scarce slot claims its player
 * before a flex can absorb them. Ties keep roster order for stability.
 */
export function slotsByScarcity(slots: readonly string[]): string[] {
  return [...slots]
    .map((slot, i) => ({ slot, i, n: eligiblePositions(slot).length }))
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.slot);
}

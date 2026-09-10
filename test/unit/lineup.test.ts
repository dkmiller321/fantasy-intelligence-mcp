import { describe, expect, it } from "vitest";
import type { Position } from "../../src/domain/types";
import { type LineupCandidate, optimizeLineup } from "../../src/engine/lineup";

function p(
  name: string,
  position: Position,
  points: number | null,
  extra: Partial<LineupCandidate> = {},
): LineupCandidate {
  return {
    canonicalId: name,
    name,
    position,
    fantasyPositions: extra.fantasyPositions ?? [position],
    points,
    eligible: extra.eligible ?? true,
  };
}

describe("optimizeLineup", () => {
  it("fills each slot with the best eligible player", () => {
    const slots = ["QB", "RB", "WR", "BN"];
    const out = optimizeLineup(slots, [
      p("QB1", "QB", 20),
      p("RB1", "RB", 15),
      p("RB2", "RB", 9),
      p("WR1", "WR", 12),
    ]);
    const picks = out.assignments.map((a) => `${a.slot}:${a.player?.name}`);
    expect(picks).toEqual(["QB:QB1", "RB:RB1", "WR:WR1"]);
    expect(out.projectedTotal).toBe(47);
    expect(out.bench.map((b) => b.name)).toEqual(["RB2"]);
  });

  it("reports the runner-up and margin for each slot", () => {
    const out = optimizeLineup(["RB"], [p("RB1", "RB", 15), p("RB2", "RB", 12.5)]);
    const rb = out.assignments[0];
    expect(rb?.player?.name).toBe("RB1");
    expect(rb?.runnerUp?.name).toBe("RB2");
    expect(rb?.margin).toBe(2.5);
  });

  it("excludes injured players but keeps them off the field, not out of the roster", () => {
    const out = optimizeLineup(
      ["RB"],
      [p("RB1", "RB", 20, { eligible: false }), p("RB2", "RB", 8)],
    );
    expect(out.assignments[0]?.player?.name).toBe("RB2");
    expect(out.bench.map((b) => b.name)).toContain("RB1");
  });

  it("fills a scarce slot before a flex can absorb its only candidate", () => {
    // The lone TE would otherwise be taken by FLEX, leaving TE empty.
    const out = optimizeLineup(["FLEX", "TE"], [p("TE1", "TE", 14), p("RB1", "RB", 10)]);
    const byName = Object.fromEntries(out.assignments.map((a) => [a.slot, a.player?.name]));
    expect(byName.TE).toBe("TE1");
    expect(byName.FLEX).toBe("RB1");
    expect(out.unfilledSlots).toHaveLength(0);
  });

  it("handles this league's four IDP_FLEX slots", () => {
    const slots = ["DL", "LB", "DB", "IDP_FLEX", "IDP_FLEX", "IDP_FLEX", "IDP_FLEX"];
    const out = optimizeLineup(slots, [
      p("DL1", "DL", 12),
      p("DL2", "DL", 9),
      p("LB1", "LB", 14),
      p("LB2", "LB", 11),
      p("DB1", "DB", 10),
      p("DB2", "DB", 8),
      p("DB3", "DB", 7),
    ]);
    expect(out.assignments).toHaveLength(7);
    expect(out.assignments.every((a) => a.player !== null)).toBe(true);
    // Every defender is used; the best go to the dedicated slots.
    expect(out.bench).toHaveLength(0);
  });

  it("respects multi-position eligibility", () => {
    // A DL/LB hybrid can fill the LB slot when no pure LB exists.
    const out = optimizeLineup(["LB"], [p("Hybrid", "DL", 11, { fantasyPositions: ["DL", "LB"] })]);
    expect(out.assignments[0]?.player?.name).toBe("Hybrid");
  });

  it("reports slots it cannot fill instead of inventing a starter", () => {
    const out = optimizeLineup(["QB", "K"], [p("QB1", "QB", 18)]);
    expect(out.unfilledSlots).toEqual(["K"]);
    expect(out.assignments.find((a) => a.slot === "K")?.player).toBeNull();
  });

  it("skips players with no projection at all", () => {
    const out = optimizeLineup(["RB"], [p("RB1", "RB", null), p("RB2", "RB", 5)]);
    expect(out.assignments[0]?.player?.name).toBe("RB2");
  });

  it("returns assignments in roster order, not solve order", () => {
    const slots = ["FLEX", "QB", "RB"];
    const out = optimizeLineup(slots, [p("QB1", "QB", 20), p("RB1", "RB", 15), p("RB2", "RB", 10)]);
    expect(out.assignments.map((a) => a.slot)).toEqual(["FLEX", "QB", "RB"]);
  });
});

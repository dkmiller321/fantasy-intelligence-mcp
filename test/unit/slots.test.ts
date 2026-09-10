import { describe, expect, it } from "vitest";
import { canFill, eligiblePositions, slotsByScarcity, startingSlots } from "../../src/engine/slots";
import league from "../fixtures/sleeper/league.json";

const rosterPositions = league.roster_positions as string[];

describe("slot eligibility", () => {
  it("keeps the league's 18 starting slots and drops 11 bench", () => {
    const starting = startingSlots(rosterPositions);
    expect(starting).toHaveLength(18);
    expect(starting.filter((s) => s === "IDP_FLEX")).toHaveLength(4);
    expect(starting).toContain("REC_FLEX");
    expect(rosterPositions.filter((s) => s === "BN")).toHaveLength(11);
  });

  it("REC_FLEX takes receivers and tight ends but not backs", () => {
    expect(canFill("REC_FLEX", ["WR"])).toBe(true);
    expect(canFill("REC_FLEX", ["TE"])).toBe(true);
    expect(canFill("REC_FLEX", ["RB"])).toBe(false);
  });

  it("IDP_FLEX takes any defender but no offensive player", () => {
    expect(canFill("IDP_FLEX", ["LB"])).toBe(true);
    expect(canFill("IDP_FLEX", ["DL"])).toBe(true);
    expect(canFill("IDP_FLEX", ["DB"])).toBe(true);
    expect(canFill("IDP_FLEX", ["WR"])).toBe(false);
  });

  it("FLEX excludes quarterbacks and defenders", () => {
    expect(canFill("FLEX", ["RB"])).toBe(true);
    expect(canFill("FLEX", ["QB"])).toBe(false);
    expect(canFill("FLEX", ["LB"])).toBe(false);
  });

  it("honours multi-position eligibility", () => {
    // Von Miller is position LB with fantasy_positions [DL, LB].
    expect(canFill("DL", ["DL", "LB"])).toBe(true);
    expect(canFill("LB", ["DL", "LB"])).toBe(true);
    expect(canFill("DB", ["DL", "LB"])).toBe(false);
  });

  it("orders scarce slots before flexes, ties keeping roster order", () => {
    const order = slotsByScarcity(["IDP_FLEX", "QB", "FLEX", "LB"]);
    // QB and LB accept one position each and resolve first, in roster order.
    // FLEX and IDP_FLEX both accept three, so they tie and stay in roster order.
    expect(order).toEqual(["QB", "LB", "IDP_FLEX", "FLEX"]);
  });

  it("returns no eligibility for an unknown slot rather than throwing", () => {
    expect(eligiblePositions("MYSTERY")).toEqual([]);
    expect(canFill("MYSTERY", ["WR"])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { InjuryStatus } from "../../src/domain/types";
import {
  type DepthEntry,
  describeOpportunity,
  roleOpportunity,
} from "../../src/engine/opportunity";

function e(name: string, posRank: number, injury: InjuryStatus = "healthy"): DepthEntry {
  return { canonicalId: name, name, posAbb: "RB", posRank, injury };
}

describe("roleOpportunity", () => {
  it("treats the listed starter as the full opportunity", () => {
    const starter = e("Starter", 1);
    const o = roleOpportunity(starter, [starter, e("Backup", 2)]);
    expect(o.score).toBe(1);
    expect(o.effectiveRank).toBe(1);
  });

  it("promotes the backup when the starter is out", () => {
    const backup = e("Backup", 2);
    const o = roleOpportunity(backup, [e("Starter", 1, "out"), backup]);
    expect(o.score).toBe(0.95);
    expect(o.effectiveRank).toBe(1);
    expect(o.openedBy.map((p) => p.name)).toEqual(["Starter"]);
    expect(o.blockedBy).toEqual([]);
  });

  it("does not promote past a healthy starter", () => {
    const backup = e("Backup", 2);
    const o = roleOpportunity(backup, [e("Starter", 1), backup]);
    expect(o.score).toBe(0.45);
    expect(o.blockedBy).toEqual(["Starter"]);
    expect(o.openedBy).toEqual([]);
  });

  it("counts every unavailable player ahead, not just the first", () => {
    const third = e("Third", 3);
    const o = roleOpportunity(third, [e("First", 1, "ir"), e("Second", 2, "out"), third]);
    expect(o.effectiveRank).toBe(1);
    expect(o.score).toBe(0.95);
    expect(o.openedBy).toHaveLength(2);
  });

  it("leaves a deep backup low even when someone ahead is hurt", () => {
    const fourth = e("Fourth", 4);
    const o = roleOpportunity(fourth, [e("A", 1), e("B", 2), e("C", 3, "out"), fourth]);
    expect(o.effectiveRank).toBe(3);
    expect(o.score).toBe(0.15);
    expect(o.blockedBy).toEqual(["A", "B"]);
  });

  it("treats questionable as still playing, because it is", () => {
    const backup = e("Backup", 2);
    const o = roleOpportunity(backup, [e("Starter", 1, "questionable"), backup]);
    expect(o.blockedBy).toEqual(["Starter"]);
    expect(o.score).toBe(0.45);
  });

  it("stays neutral with no depth chart entry rather than guessing", () => {
    const o = roleOpportunity(null, []);
    expect(o.score).toBe(0.2);
    expect(o.rank).toBeNull();
  });
});

describe("describeOpportunity", () => {
  it("names who is out when the role has opened", () => {
    const backup = e("Backup", 2);
    const o = roleOpportunity(backup, [e("Bijan Robinson", 1, "out"), backup]);
    expect(describeOpportunity(o, "RB")).toBe(
      "in line to start at RB with Bijan Robinson (out) unavailable",
    );
  });

  it("is honest when the player moved up but is still buried", () => {
    const third = e("Third", 3);
    const o = roleOpportunity(third, [e("A", 1), e("B", 2, "ir"), third]);
    expect(describeOpportunity(o, "WR")).toContain("still behind A");
  });

  it("says nothing when there is nothing to say", () => {
    const fourth = e("Fourth", 4);
    const o = roleOpportunity(fourth, [e("A", 1), e("B", 2), e("C", 3), fourth]);
    expect(describeOpportunity(o, "RB")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { CONFIG, priorSeasonWeight } from "../../src/engine/config";
import {
  composite,
  confidence,
  consensusProjection,
  environmentMultiplier,
  injuryMultiplier,
  isExcludedByInjury,
  matchupMultiplier,
  projectionRange,
} from "../../src/engine/project";

describe("consensusProjection", () => {
  it("returns the single source unchanged", () => {
    const c = consensusProjection([{ source: "sleeper", points: 12.4 }]);
    expect(c?.points).toBe(12.4);
    expect(c?.agreement).toBe(1);
  });

  it("weights a multi-analyst consensus above a single vendor", () => {
    // FantasyPros 0.6, Sleeper 0.35: (10 x 0.6 + 20 x 0.35) / 0.95 = 13 / 0.95
    const c = consensusProjection([
      { source: "fantasypros", points: 10 },
      { source: "sleeper", points: 20 },
    ]);
    expect(c?.points).toBeCloseTo(13 / 0.95, 5);
    // The result leans toward the more heavily weighted source.
    expect(c?.points).toBeLessThan(15);
  });

  it("weights ESPN and Sleeper evenly, since each is one house projection", () => {
    // Equal weights, so the blend is the plain mean.
    const c = consensusProjection([
      { source: "espn", points: 12 },
      { source: "sleeper", points: 18 },
    ]);
    expect(c?.points).toBeCloseTo(15, 5);
    expect(c?.sources).toEqual(["espn", "sleeper"]);
  });

  it("blends all three when every source is present", () => {
    const c = consensusProjection([
      { source: "fantasypros", points: 10 },
      { source: "espn", points: 20 },
      { source: "sleeper", points: 20 },
    ]);
    // (10 x 0.6 + 20 x 0.35 + 20 x 0.35) / 1.3 = 20 / 1.3
    expect(c?.points).toBeCloseTo(20 / 1.3, 5);
    expect(c?.sources).toHaveLength(3);
  });

  it("reports lower agreement as sources diverge", () => {
    const tight = consensusProjection([
      { source: "fantasypros", points: 15 },
      { source: "sleeper", points: 15 },
    ]);
    const loose = consensusProjection([
      { source: "fantasypros", points: 5 },
      { source: "sleeper", points: 25 },
    ]);
    expect(tight?.agreement).toBe(1);
    expect(loose?.agreement).toBeLessThan(0.5);
  });

  it("returns null with no sources at all", () => {
    expect(consensusProjection([])).toBeNull();
  });
});

describe("projectionRange", () => {
  it("prefers provider floor and ceiling", () => {
    const r = projectionRange(12, [{ source: "fp", points: 12, floor: 6, ceiling: 20 }], [], 4);
    expect(r).toEqual({ floor: 6, ceiling: 20, basis: "source" });
  });

  it("uses one sigma of recent weeks when the provider gives no band", () => {
    // Points 8,10,12,14,16 -> mean 12, variance 8, sigma 2.828...
    const r = projectionRange(12, [{ source: "s", points: 12 }], [8, 10, 12, 14, 16], 5);
    expect(r.basis).toBe("history");
    expect(r.ceiling - 12).toBeCloseTo(Math.sqrt(8), 5);
  });

  it("falls back to position sigma below the minimum game count", () => {
    const r = projectionRange(10, [{ source: "s", points: 10 }], [9, 11], 4);
    expect(r).toEqual({ floor: 6, ceiling: 14, basis: "position" });
  });

  it("never returns a negative floor", () => {
    expect(projectionRange(2, [{ source: "s", points: 2 }], [], 9).floor).toBe(0);
  });
});

describe("matchupMultiplier", () => {
  it("is neutral without opponent data", () => {
    expect(matchupMultiplier(null, 12, 3).multiplier).toBe(1);
  });

  it("rewards a generous defence and punishes a stingy one", () => {
    // +2 sigma -> 1 + 2 x 0.06 = 1.12
    expect(matchupMultiplier(18, 12, 3).multiplier).toBeCloseTo(1.12, 5);
    expect(matchupMultiplier(6, 12, 3).multiplier).toBeCloseTo(0.88, 5);
  });

  it("clamps to the configured bounds", () => {
    expect(matchupMultiplier(100, 12, 3).multiplier).toBe(CONFIG.matchup.max);
    expect(matchupMultiplier(-100, 12, 3).multiplier).toBe(CONFIG.matchup.min);
  });
});

describe("environmentMultiplier", () => {
  const base = { impliedTeamTotal: null, roof: null, windMph: null, precipProb: null };

  it("is neutral with nothing known", () => {
    expect(environmentMultiplier(base, "WR", 22, 3).multiplier).toBe(1);
  });

  it("raises a high implied total", () => {
    // +2 sigma -> 1 + 2 x 0.05 = 1.10
    const e = environmentMultiplier({ ...base, impliedTeamTotal: 28 }, "WR", 22, 3);
    expect(e.multiplier).toBeCloseTo(1.1, 5);
  });

  it("applies a wind penalty outdoors to passing positions only", () => {
    const windy = { ...base, roof: "outdoors", windMph: 18 };
    expect(environmentMultiplier(windy, "WR", 22, 3).multiplier).toBeCloseTo(0.92, 5);
    // Running backs are not in windAffects.
    expect(environmentMultiplier(windy, "RB", 22, 3).multiplier).toBe(1);
  });

  it("ignores weather indoors", () => {
    const dome = { ...base, roof: "dome", windMph: 30, precipProb: 0.9 };
    expect(environmentMultiplier(dome, "QB", 22, 3).multiplier).toBe(1);
  });

  it("compounds wind and precipitation", () => {
    const bad = { ...base, roof: "outdoors", windMph: 20, precipProb: 0.8 };
    expect(environmentMultiplier(bad, "K", 22, 3).multiplier).toBeCloseTo(0.92 * 0.96, 5);
  });
});

describe("injury handling", () => {
  it("excludes players who cannot play", () => {
    for (const s of ["out", "ir", "doubtful", "suspended", "pup"] as const) {
      expect(isExcludedByInjury(s)).toBe(true);
      expect(injuryMultiplier(s)).toBe(0);
    }
  });

  it("discounts questionable and leaves healthy alone", () => {
    expect(injuryMultiplier("questionable")).toBe(0.9);
    expect(injuryMultiplier("healthy")).toBe(1);
  });
});

describe("composite", () => {
  it("multiplies the factors and reports each one", () => {
    const c = composite({
      consensus: { points: 10, sources: ["sleeper"], agreement: 1 },
      matchup: { multiplier: 1.1, z: 1.67 },
      environment: { multiplier: 0.92, notes: ["wind 18 mph"] },
      injuryStatus: "questionable",
      opponent: "KC",
    });
    // 10 x 1.1 x 0.92 x 0.9 = 9.108
    expect(c.points).toBeCloseTo(9.108, 5);
    const factors = c.evidence.map((e) => e.factor);
    expect(factors).toEqual(["consensus projection", "matchup", "game environment", "injury"]);
    expect(c.evidence[1]?.effect).toBe("+");
    expect(c.evidence[2]?.effect).toBe("-");
  });

  it("omits factors that are exactly neutral", () => {
    const c = composite({
      consensus: { points: 10, sources: ["a", "b"], agreement: 1 },
      matchup: { multiplier: 1, z: 0 },
      environment: { multiplier: 1, notes: [] },
      injuryStatus: "healthy",
      opponent: null,
    });
    expect(c.evidence).toHaveLength(1);
    expect(c.points).toBe(10);
  });

  it("zeroes an excluded player", () => {
    const c = composite({
      consensus: { points: 18, sources: ["s"], agreement: 1 },
      matchup: { multiplier: 1.1, z: 1 },
      environment: { multiplier: 1, notes: [] },
      injuryStatus: "out",
      opponent: "SEA",
    });
    expect(c.points).toBe(0);
  });
});

describe("confidence", () => {
  it("computes the SPEC formula", () => {
    // 0.5 + 0.2 x 1 + 0.2 x 0.5 - 0 - 0 = 0.80
    const c = confidence({
      sourceAgreement: 1,
      projectionGap: 0.5,
      injuryUncertain: false,
      missingSources: 0,
      singleSource: false,
    });
    expect(c).toBe(0.8);
  });

  it("subtracts for injury uncertainty and missing sources", () => {
    // 0.5 + 0.2 + 0.2 - 0.15 - 0.10 = 0.65
    expect(
      confidence({
        sourceAgreement: 1,
        projectionGap: 1,
        injuryUncertain: true,
        missingSources: 1,
        singleSource: false,
      }),
    ).toBe(0.65);
  });

  it("caps a single-source call at 0.7 however good it looks", () => {
    expect(
      confidence({
        sourceAgreement: 1,
        projectionGap: 1,
        injuryUncertain: false,
        missingSources: 0,
        singleSource: true,
      }),
    ).toBe(CONFIG.singleSourceConfidenceCap);
  });

  it("stays inside the configured bounds", () => {
    const low = confidence({
      sourceAgreement: 0,
      projectionGap: 0,
      injuryUncertain: true,
      missingSources: 1,
      singleSource: false,
    });
    expect(low).toBeGreaterThanOrEqual(CONFIG.confidence.min);
  });
});

describe("priorSeasonWeight", () => {
  it("leans entirely on last season in week 1 and not at all from week 7", () => {
    expect(priorSeasonWeight(1)).toBe(1);
    expect(priorSeasonWeight(7)).toBe(0);
    expect(priorSeasonWeight(12)).toBe(0);
  });

  it("crosses roughly half way at week 4", () => {
    expect(priorSeasonWeight(4)).toBeCloseTo(0.5, 5);
  });

  it("decreases monotonically", () => {
    for (let w = 1; w < 8; w++) {
      expect(priorSeasonWeight(w)).toBeGreaterThanOrEqual(priorSeasonWeight(w + 1));
    }
  });
});

import { describe, expect, it } from "vitest";
import type { Position } from "../../src/domain/types";
import { CONFIG } from "../../src/engine/config";
import { ageMultiplier, evaluateTrade, scoreWaiver, valueAsset } from "../../src/engine/trade";

function asset(name: string, position: Position, ppg: number, age: number | null, repl = 8) {
  return { canonicalId: name, name, position, pointsPerGame: ppg, age, replacementPpg: repl };
}

describe("ageMultiplier", () => {
  it("is neutral without an age", () => {
    expect(ageMultiplier("RB", null)).toBe(1);
  });

  it("is neutral at the positional peak", () => {
    expect(ageMultiplier("RB", CONFIG.trade.ageCurve.RB?.peak ?? 26)).toBe(1);
  });

  it("penalises running backs faster than receivers past peak", () => {
    const rb = ageMultiplier("RB", 30);
    const wr = ageMultiplier("WR", 30);
    expect(rb).toBeLessThan(1);
    expect(rb).toBeLessThan(wr);
  });

  it("rewards youth below peak", () => {
    expect(ageMultiplier("RB", 22)).toBeGreaterThan(1);
  });

  it("never exceeds the configured cap in either direction", () => {
    const cap = CONFIG.trade.maxAgeAdjustment;
    expect(ageMultiplier("RB", 40)).toBeGreaterThanOrEqual(1 - cap);
    expect(ageMultiplier("RB", 18)).toBeLessThanOrEqual(1 + cap);
  });
});

describe("valueAsset", () => {
  it("values a player over replacement, not in absolute points", () => {
    // 14 ppg against an 8 ppg replacement over 10 weeks with 0 playoff weeks = 60.
    const v = valueAsset(asset("A", "WR", 14, 28), 10, 0);
    expect(v.valueOverReplacement).toBe(6);
    expect(v.adjustedValue).toBe(60);
  });

  it("weights playoff weeks more heavily", () => {
    const noPlayoffs = valueAsset(asset("A", "WR", 14, 28), 10, 0).adjustedValue;
    const withPlayoffs = valueAsset(asset("A", "WR", 14, 28), 10, 3).adjustedValue;
    expect(withPlayoffs).toBeGreaterThan(noPlayoffs);
  });

  it("can value a replacement-level player at zero", () => {
    expect(valueAsset(asset("A", "WR", 8, 28), 10, 0).adjustedValue).toBe(0);
  });

  it("prefers the younger of two equal producers in dynasty", () => {
    const young = valueAsset(asset("Young", "RB", 14, 23), 10, 3).adjustedValue;
    const old = valueAsset(asset("Old", "RB", 14, 30), 10, 3).adjustedValue;
    expect(young).toBeGreaterThan(old);
  });
});

describe("evaluateTrade", () => {
  const mk = (name: string, ppg: number, age: number) =>
    valueAsset(asset(name, "WR", ppg, age), 10, 3);

  it("recommends accepting a clear win", () => {
    const out = evaluateTrade([mk("Mine", 9, 28)], [mk("Theirs", 18, 26)]);
    expect(out.net).toBeGreaterThan(0);
    expect(out.verdict).toBe("accept");
  });

  it("recommends declining a clear loss", () => {
    const out = evaluateTrade([mk("Mine", 18, 26)], [mk("Theirs", 9, 28)]);
    expect(out.verdict).toBe("decline");
  });

  it("calls an even trade close", () => {
    const out = evaluateTrade([mk("Mine", 14, 27)], [mk("Theirs", 14, 27)]);
    expect(out.net).toBe(0);
    expect(out.verdict).toBe("close");
  });

  it("notes roster fit when the sides are uneven", () => {
    const out = evaluateTrade([mk("A", 12, 26), mk("B", 11, 27)], [mk("C", 20, 25)]);
    expect(out.rosterFitNote).toContain("Consolidating");
  });

  it("has no roster-fit note for a one-for-one", () => {
    expect(evaluateTrade([mk("A", 12, 26)], [mk("C", 12, 26)]).rosterFitNote).toBeNull();
  });
});

describe("scoreWaiver", () => {
  const base = {
    canonicalId: "x",
    name: "X",
    position: "RB" as Position,
    rosValue: 0.5,
    usageTrend: 0,
    opportunity: 0,
    trendingAdds: 0,
  };

  it("scores higher for rising usage", () => {
    const flat = scoreWaiver(base, 100).score;
    const rising = scoreWaiver({ ...base, usageTrend: 1 }, 100).score;
    expect(rising).toBeGreaterThan(flat);
  });

  it("scores higher when opportunity opens up", () => {
    expect(scoreWaiver({ ...base, opportunity: 1 }, 100).score).toBeGreaterThan(
      scoreWaiver(base, 100).score,
    );
  });

  it("lets trending adds nudge but not dominate", () => {
    const hyped = scoreWaiver({ ...base, trendingAdds: 100 }, 100).score;
    const quality = scoreWaiver({ ...base, rosValue: 1 }, 100).score;
    expect(hyped).toBeGreaterThan(scoreWaiver(base, 100).score);
    expect(quality).toBeGreaterThan(hyped);
  });

  it("assigns a bigger FAAB band to a better target", () => {
    const strong = scoreWaiver(
      { ...base, rosValue: 1, usageTrend: 1, opportunity: 1, trendingAdds: 100 },
      100,
    );
    const weak = scoreWaiver({ ...base, rosValue: 0, usageTrend: -1 }, 100);
    expect(strong.faabHigh).toBeGreaterThan(weak.faabHigh);
    expect(weak.faabLow).toBeGreaterThanOrEqual(1);
  });

  it("keeps the score inside 0 and 1", () => {
    const s = scoreWaiver(
      { ...base, rosValue: 5, usageTrend: 5, opportunity: 5, trendingAdds: 999 },
      100,
    );
    expect(s.score).toBeLessThanOrEqual(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  lineupSigma,
  normalCdf,
  playoffOutlook,
  swingPlayers,
  winProbability,
} from "../../src/engine/matchup";

describe("normalCdf", () => {
  it("is a half at the mean and symmetric", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 6);
  });

  it("matches known values", () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-2)).toBeCloseTo(0.0228, 3);
  });
});

describe("winProbability", () => {
  it("is a coin flip between identical teams", () => {
    expect(winProbability({ mean: 120, sigma: 20 }, { mean: 120, sigma: 20 })).toBeCloseTo(0.5, 6);
  });

  it("favours the higher projection", () => {
    const p = winProbability({ mean: 130, sigma: 20 }, { mean: 110, sigma: 20 });
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(1);
  });

  it("is less certain when both teams are volatile", () => {
    const tight = winProbability({ mean: 130, sigma: 5 }, { mean: 110, sigma: 5 });
    const loose = winProbability({ mean: 130, sigma: 40 }, { mean: 110, sigma: 40 });
    expect(tight).toBeGreaterThan(loose);
  });

  it("is decisive when neither team varies", () => {
    expect(winProbability({ mean: 130, sigma: 0 }, { mean: 110, sigma: 0 })).toBe(1);
    expect(winProbability({ mean: 90, sigma: 0 }, { mean: 110, sigma: 0 })).toBe(0);
  });
});

describe("lineupSigma", () => {
  it("combines independent player bands in quadrature", () => {
    // Two players each with a band of 10 -> sigma 5 apiece -> sqrt(50).
    expect(
      lineupSigma([
        { floor: 5, ceiling: 15 },
        { floor: 5, ceiling: 15 },
      ]),
    ).toBeCloseTo(Math.sqrt(50), 6);
  });

  it("is zero for a perfectly certain lineup", () => {
    expect(lineupSigma([{ floor: 10, ceiling: 10 }])).toBe(0);
  });
});

describe("swingPlayers", () => {
  it("surfaces the widest ranges first", () => {
    const out = swingPlayers(
      [
        { name: "steady", floor: 9, ceiling: 11 },
        { name: "boom", floor: 2, ceiling: 30 },
        { name: "mid", floor: 6, ceiling: 16 },
      ],
      2,
    );
    expect(out.map((p) => p.name)).toEqual(["boom", "mid"]);
  });
});

describe("playoffOutlook", () => {
  const player = {
    canonicalId: "x",
    name: "X",
    position: "WR",
    team: "KC",
    byeWeek: 15,
  };
  const opponentFor = (_team: string, week: number) => (week === 16 ? "DAL" : "SEA");
  // DAL most generous (1), SEA toughest (32).
  const rankFor = (opponent: string) => (opponent === "DAL" ? 1 : 32);

  it("scores each playoff week and flags byes", () => {
    const out = playoffOutlook(player, [14, 15, 16], opponentFor, rankFor, 32);
    expect(out.weeks).toHaveLength(3);
    expect(out.byeConflicts).toEqual([15]);
    expect(out.weeks[1]?.onBye).toBe(true);
  });

  it("gives the most generous defence the top percentile", () => {
    const out = playoffOutlook(player, [16], opponentFor, rankFor, 32);
    expect(out.weeks[0]?.rank).toBe(1);
    expect(out.weeks[0]?.percentile).toBe(1);
  });

  it("gives the toughest defence the bottom percentile", () => {
    const out = playoffOutlook(player, [14], opponentFor, rankFor, 32);
    expect(out.weeks[0]?.percentile).toBe(0);
  });

  it("excludes bye weeks from the average", () => {
    const out = playoffOutlook(player, [15, 16], opponentFor, rankFor, 32);
    // Week 15 is a bye, so only week 16 (percentile 1) counts.
    expect(out.score).toBe(1);
  });

  it("returns a null score when nothing is known", () => {
    const out = playoffOutlook(
      { ...player, team: null },
      [14],
      () => null,
      () => null,
      32,
    );
    expect(out.score).toBeNull();
  });
});

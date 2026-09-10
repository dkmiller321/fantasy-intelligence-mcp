import { describe, expect, it } from "vitest";
import {
  defenseVsPosition,
  dvpDistribution,
  positionSigma,
  usageTrend,
  type WeekRow,
} from "../../src/engine/aggregate";

function row(p: Partial<WeekRow> & { opponent: string; points: number; week: number }): WeekRow {
  return {
    playerId: p.playerId ?? "x",
    position: p.position ?? "WR",
    season: p.season ?? 2026,
    week: p.week,
    opponent: p.opponent,
    points: p.points,
  };
}

describe("defenseVsPosition", () => {
  it("averages points allowed per game, not per player-row", () => {
    // KC faced two WRs in week 1 (10 + 20) and one in week 2 (12).
    // 42 points over 2 games = 21.0 per game.
    const current = [
      row({ opponent: "KC", points: 10, week: 1 }),
      row({ opponent: "KC", points: 20, week: 1 }),
      row({ opponent: "KC", points: 12, week: 2 }),
    ];
    const out = defenseVsPosition(current, [], 2);
    expect(out.find((r) => r.team === "KC")?.fpaPerGame).toBe(21);
  });

  it("ranks the most generous defence first", () => {
    const current = [
      row({ opponent: "KC", points: 30, week: 1 }),
      row({ opponent: "SEA", points: 5, week: 1 }),
    ];
    const out = defenseVsPosition(current, [], 1);
    expect(out.find((r) => r.team === "KC")?.rank).toBe(1);
    expect(out.find((r) => r.team === "SEA")?.rank).toBe(2);
  });

  it("uses prior season alone in week 1, where the current season is empty", () => {
    const prior = [
      row({ opponent: "KC", points: 18, week: 5, season: 2025 }),
      row({ opponent: "KC", points: 22, week: 6, season: 2025 }),
    ];
    const out = defenseVsPosition([], prior, 1);
    const kc = out.find((r) => r.team === "KC");
    expect(kc?.priorWeight).toBe(1);
    expect(kc?.fpaPerGame).toBe(20);
  });

  it("blends prior and current at week 4", () => {
    // prior average 20, current average 10, prior weight 0.5 -> 15.
    const prior = [row({ opponent: "KC", points: 20, week: 1, season: 2025 })];
    const current = [row({ opponent: "KC", points: 10, week: 4 })];
    const kc = defenseVsPosition(current, prior, 4).find((r) => r.team === "KC");
    expect(kc?.priorWeight).toBeCloseTo(0.5, 5);
    expect(kc?.fpaPerGame).toBeCloseTo(15, 5);
  });

  it("ignores the prior season from week 7", () => {
    const prior = [row({ opponent: "KC", points: 40, week: 1, season: 2025 })];
    const current = [row({ opponent: "KC", points: 10, week: 7 })];
    const kc = defenseVsPosition(current, prior, 7).find((r) => r.team === "KC");
    expect(kc?.priorWeight).toBe(0);
    expect(kc?.fpaPerGame).toBe(10);
  });

  it("honours the six-week rolling window", () => {
    const current = [
      row({ opponent: "KC", points: 100, week: 1 }),
      row({ opponent: "KC", points: 10, week: 8 }),
    ];
    // Through week 8 the window starts at week 3, so week 1 is excluded.
    const kc = defenseVsPosition(current, [], 8).find((r) => r.team === "KC");
    expect(kc?.fpaPerGame).toBe(10);
  });

  it("keeps IDP positions separate from offensive ones", () => {
    const current = [
      row({ opponent: "KC", points: 30, week: 1, position: "WR" }),
      row({ opponent: "KC", points: 8, week: 1, position: "LB" }),
    ];
    const out = defenseVsPosition(current, [], 1);
    expect(out.find((r) => r.team === "KC" && r.position === "WR")?.fpaPerGame).toBe(30);
    expect(out.find((r) => r.team === "KC" && r.position === "LB")?.fpaPerGame).toBe(8);
  });

  it("drops rows with no opponent rather than crediting a phantom defence", () => {
    const out = defenseVsPosition(
      [{ ...row({ opponent: "KC", points: 5, week: 1 }), opponent: null }],
      [],
      1,
    );
    expect(out).toHaveLength(0);
  });
});

describe("dvpDistribution", () => {
  it("returns the mean and sigma across teams for one position", () => {
    const rows = defenseVsPosition(
      [
        row({ opponent: "A", points: 10, week: 1 }),
        row({ opponent: "B", points: 20, week: 1 }),
        row({ opponent: "C", points: 30, week: 1 }),
      ],
      [],
      1,
    );
    const d = dvpDistribution(rows, "WR");
    expect(d.mean).toBeCloseTo(20, 5);
    expect(d.sigma).toBeCloseTo(Math.sqrt(200 / 3), 5);
  });

  it("is empty-safe", () => {
    expect(dvpDistribution([], "QB")).toEqual({ mean: 0, sigma: 0 });
  });
});

describe("usageTrend", () => {
  const weeks = [
    { week: 1, value: 0.1 },
    { week: 2, value: 0.1 },
    { week: 3, value: 0.1 },
    { week: 4, value: 0.3 },
    { week: 5, value: 0.3 },
    { week: 6, value: 0.3 },
  ];

  it("labels a climbing share as rising", () => {
    const t = usageTrend("p", "target_share", weeks, 6);
    expect(t?.recent).toBeCloseTo(0.3, 5);
    expect(t?.prior).toBeCloseTo(0.1, 5);
    expect(t?.label).toBe("rising");
  });

  it("labels the reverse as falling", () => {
    const t = usageTrend(
      "p",
      "target_share",
      [...weeks].reverse().map((v, i) => ({ week: i + 1, value: v.value })),
      6,
    );
    expect(t?.label).toBe("falling");
  });

  it("calls a small change flat", () => {
    const flat = weeks.map((w) => ({ week: w.week, value: 0.2 }));
    expect(usageTrend("p", "target_share", flat, 6)?.label).toBe("flat");
  });

  it("returns null without two full windows", () => {
    expect(usageTrend("p", "target_share", [{ week: 1, value: 0.2 }], 1)).toBeNull();
  });
});

describe("positionSigma", () => {
  it("falls back to a default with too little data", () => {
    expect(positionSigma([], "WR")).toBe(4);
  });

  it("measures spread when data exists", () => {
    const rows = [
      row({ opponent: "A", points: 10, week: 1 }),
      row({ opponent: "A", points: 20, week: 2 }),
    ];
    expect(positionSigma(rows, "WR")).toBeCloseTo(5, 5);
  });
});

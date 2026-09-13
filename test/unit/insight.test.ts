import { describe, expect, it } from "vitest";
import { classifyScript, gameScript } from "../../src/engine/gamescript";
import { scoringHistory, usageDivergence } from "../../src/engine/history";

const slate = { slateMeanTotal: 46 };

describe("classifyScript", () => {
  it("reads the home spread from each side correctly", () => {
    // nflverse publishes +7 when the home team is favoured by a touchdown.
    expect(
      classifyScript({ homeSpread: 7, isHome: true, total: 45, impliedTeamTotal: 26, ...slate }),
    ).toBe("heavy favourite");
    expect(
      classifyScript({ homeSpread: 7, isHome: false, total: 45, impliedTeamTotal: 19, ...slate }),
    ).toBe("heavy underdog");
  });

  it("calls a close line a toss-up from either side", () => {
    for (const isHome of [true, false]) {
      expect(
        classifyScript({ homeSpread: 1.5, isHome, total: 45, impliedTeamTotal: 23, ...slate }),
      ).toBe("toss-up");
    }
  });

  it("returns null without a line rather than guessing", () => {
    expect(
      classifyScript({
        homeSpread: null,
        isHome: true,
        total: null,
        impliedTeamTotal: null,
        ...slate,
      }),
    ).toBeNull();
  });
});

describe("gameScript implications", () => {
  const heavyFavourite = {
    homeSpread: 10,
    isHome: true,
    total: 44,
    impliedTeamTotal: 27,
    ...slate,
  };
  const heavyUnderdog = {
    homeSpread: 10,
    isHome: false,
    total: 44,
    impliedTeamTotal: 17,
    ...slate,
  };

  it("tells a back on a favourite that carries are the path", () => {
    const s = gameScript("RB", heavyFavourite);
    expect(s.label).toBe("heavy favourite");
    expect(s.implication).toContain("carries");
  });

  it("tells a back on an underdog that carries thin out", () => {
    expect(gameScript("RB", heavyUnderdog).implication).toContain("thin out");
  });

  it("tells a receiver on an underdog that volume rises", () => {
    const s = gameScript("WR", heavyUnderdog);
    expect(s.implication).toContain("throw");
    expect(s.implication).toContain("volume");
  });

  it("warns a receiver on a big favourite about fewer second-half attempts", () => {
    expect(gameScript("WR", heavyFavourite).implication).toContain("fewer second-half");
  });

  it("reads defensive volume off the opponent's likely script", () => {
    // A heavy favourite's defence faces a trailing, throwing opponent: more snaps.
    expect(gameScript("LB", heavyFavourite).implication).toContain("more defensive snaps");
    expect(gameScript("LB", heavyUnderdog).implication).toContain("shortens the game");
  });

  it("flags a shootout relative to the week, not an absolute number", () => {
    const high = gameScript("WR", { ...heavyFavourite, homeSpread: 1, total: 52 });
    expect(high.shootout).toBe(true);
    const normal = gameScript("WR", { ...heavyFavourite, homeSpread: 1, total: 46 });
    expect(normal.shootout).toBe(false);
  });

  it("reports the spread from the player's own perspective", () => {
    expect(gameScript("RB", heavyFavourite).spread).toBe(-10);
    expect(gameScript("RB", heavyUnderdog).spread).toBe(10);
  });
});

describe("scoringHistory", () => {
  it("describes a steady player's real range and hit rate", () => {
    const h = scoringHistory([11, 13, 12, 14, 12, 13], 13, "Steady");
    expect(h.label).toBe("steady");
    expect(h.hitRate).toBeCloseTo(3 / 6, 5);
    expect(h.summary).toContain("median");
    expect(h.summary).toContain("fair expectation");
  });

  it("calls out a boom-or-bust profile", () => {
    const h = scoringHistory([1, 2, 28, 3, 30, 2], 12, "Swingy");
    expect(h.label).toBe("boom or bust");
    expect(h.summary).toContain("boom or bust");
  });

  it("refuses to characterise a thin sample", () => {
    const h = scoringHistory([14, 9], 12, "New");
    expect(h.label).toBe("thin sample");
    expect(h.hitRate).toBeNull();
    expect(h.summary).toContain("too few");
  });

  it("says nothing at all with no games", () => {
    expect(scoringHistory([], 12, "Rookie").summary).toBeNull();
  });

  it("reports quartiles of games that actually happened", () => {
    const h = scoringHistory([4, 8, 12, 16, 20, 24], 12, "Spread");
    expect(h.median).toBe(14);
    expect(h.floor).toBe(9);
    expect(h.ceiling).toBe(19);
  });
});

describe("usageDivergence", () => {
  it("flags snaps rising while scoring is flat as upside", () => {
    const d = usageDivergence(
      { label: "rising", delta: 0.2 },
      { label: "flat", delta: 0 },
      "Riser",
    );
    expect(d.signal).toBe("volume ahead of production");
    expect(d.note).toContain("buy before the results");
  });

  it("flags scoring rising on falling snaps as unsustainable", () => {
    const d = usageDivergence(
      { label: "falling", delta: -0.2 },
      { label: "rising", delta: 5 },
      "Lucky",
    );
    expect(d.signal).toBe("production ahead of volume");
    expect(d.note).toContain("will not repeat");
  });

  it("says nothing when the two agree", () => {
    expect(
      usageDivergence({ label: "rising", delta: 0.2 }, { label: "rising", delta: 4 }, "X").note,
    ).toBeNull();
  });

  it("is unknown without both trends", () => {
    expect(usageDivergence(null, { label: "rising", delta: 4 }, "X").signal).toBe("unknown");
  });
});

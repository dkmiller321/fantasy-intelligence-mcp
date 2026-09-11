import { describe, expect, it } from "vitest";
import { espnCovers, espnPosition, espnStatsToSleeper } from "../../src/engine/espn-map";
import { scoreStatLine } from "../../src/engine/scoring";
import league from "../fixtures/sleeper/league.json";

const scoring = league.scoring_settings as Record<string, number>;
/** ESPN's own default PPR, used only to prove the id decoding reconstructs their total. */
const ESPN_PPR: Record<string, number> = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
};

describe("espnStatsToSleeper id decoding", () => {
  // Amon-Ra St. Brown, week 1 2026, verbatim from ESPN. They report 18.83.
  const stBrown = { "23": 0.14, "24": 0.81, "42": 82.5, "43": 0.62, "53": 6.79, "58": 9.6 };

  it("reconstructs ESPN's own total, which proves the ids are right", () => {
    const line = espnStatsToSleeper(stBrown, scoring);
    expect(scoreStatLine(line, ESPN_PPR).points).toBeCloseTo(18.83, 1);
  });

  it("scores the same line under this league's 0.25 PPR instead", () => {
    const line = espnStatsToSleeper(stBrown, scoring);
    // 82.5(.1) + 6.79(.25) + 0.62(6) + 0.81(.1) = 8.25 + 1.6975 + 3.72 + 0.081
    expect(scoreStatLine(line, scoring).points).toBeCloseTo(13.75, 1);
  });

  it("reconstructs a quarterback line", () => {
    // Josh Allen, week 1 2026. ESPN reports 19.32.
    const allen = {
      "0": 30.41,
      "1": 19.72,
      "3": 223.66,
      "4": 1.27,
      "20": 0.72,
      "23": 6.75,
      "24": 32.24,
      "25": 0.62,
    };
    const line = espnStatsToSleeper(allen, scoring);
    expect(scoreStatLine(line, ESPN_PPR).points).toBeCloseTo(19.32, 0);
    expect(line.pass_yd).toBe(223.66);
    expect(line.pass_td).toBe(1.27);
  });

  it("drops volume stats this league does not score", () => {
    const line = espnStatsToSleeper({ "58": 9.6, "0": 30, "23": 6.75, "42": 50 }, scoring);
    expect(line).not.toHaveProperty("rec_tgt");
    expect(line).not.toHaveProperty("pass_att");
    expect(line).not.toHaveProperty("rush_att");
    expect(line.rec_yd).toBe(50);
  });

  it("folds ESPN's 0-39 field goal bucket into a key this league scores", () => {
    const line = espnStatsToSleeper({ "74": 1.2, "77": 0.5, "80": 0.3, "86": 2.6 }, scoring);
    expect(line).not.toHaveProperty("fgm_0_39_espn");
    expect(line.fgm_30_39).toBeCloseTo(1.2, 5);
    expect(line.fgm_40_49).toBeCloseTo(0.5, 5);
    expect(line.fgm_50p).toBeCloseTo(0.3, 5);
    expect(line.xpm).toBeCloseTo(2.6, 5);
  });

  it("ignores unknown ids rather than guessing at them", () => {
    expect(espnStatsToSleeper({ "9999": 5 }, scoring)).toEqual({});
  });

  it("discards noise below a hundredth of a point", () => {
    expect(espnStatsToSleeper({ "43": 0.001, "42": 0 }, scoring)).toEqual({});
  });

  it("never synthesises the 200-yard bonus from a fractional projection", () => {
    const line = espnStatsToSleeper({ "42": 210 }, scoring);
    expect(line).not.toHaveProperty("bonus_rec_yd_200");
  });
});

describe("espn coverage", () => {
  it("maps offensive position ids", () => {
    expect(espnPosition(1)).toBe("QB");
    expect(espnPosition(2)).toBe("RB");
    expect(espnPosition(5)).toBe("K");
    expect(espnPosition(99)).toBeNull();
  });

  it("knows it does not cover IDP, which is 7 of this league's 18 slots", () => {
    expect(espnCovers("WR")).toBe(true);
    expect(espnCovers("DL")).toBe(false);
    expect(espnCovers("LB")).toBe(false);
    expect(espnCovers("DB")).toBe(false);
  });
});

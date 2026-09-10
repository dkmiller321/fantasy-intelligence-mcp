import { describe, expect, it } from "vitest";
import { toSleeperStatLine } from "../../src/engine/nflverse-map";
import { scoreStatLine } from "../../src/engine/scoring";
import league from "../fixtures/sleeper/league.json";

const scoring = league.scoring_settings as Record<string, number>;

describe("toSleeperStatLine", () => {
  it("maps a receiving line and scores it in league rules", () => {
    const line = toSleeperStatLine({
      receptions: "7",
      receiving_yards: "104",
      receiving_tds: "1",
      targets: "11",
    });
    expect(line).toEqual({ rec: 7, rec_yd: 104, rec_td: 1 });
    // 7 x 0.25 + 104 x 0.1 + 6 = 1.75 + 10.4 + 6 = 18.15
    expect(scoreStatLine(line, scoring).points).toBe(18.15);
  });

  it("maps an IDP line and scores it in league rules", () => {
    // Calais Campbell, DE, 2025 week 1: 3 solo, 2 assists.
    const line = toSleeperStatLine({
      def_tackles_solo: "3",
      def_tackle_assists: "2",
      def_sacks: "0",
      def_pass_defended: "0",
    });
    expect(line).toEqual({ idp_tkl_solo: 3, idp_tkl_ast: 2 });
    // 3 x 1 + 2 x 0.5 = 4.0
    expect(scoreStatLine(line, scoring).points).toBe(4);
  });

  it("sums the three ways nflverse records a lost fumble", () => {
    const line = toSleeperStatLine({
      rushing_fumbles_lost: "1",
      receiving_fumbles_lost: "1",
      sack_fumbles_lost: "0",
    });
    expect(line.fum_lost).toBe(2);
  });

  it("folds nflverse's 50-59 and 60+ buckets into Sleeper's fgm_50p", () => {
    expect(toSleeperStatLine({ fg_made_50_59: "1", fg_made_60_: "1" }).fgm_50p).toBe(2);
  });

  it("flags the 200-yard receiving bonus only at the threshold", () => {
    expect(toSleeperStatLine({ receiving_yards: "199" }).bonus_rec_yd_200).toBeUndefined();
    expect(toSleeperStatLine({ receiving_yards: "200" }).bonus_rec_yd_200).toBe(1);
  });

  it("treats NA and empty as zero and omits zero keys", () => {
    const line = toSleeperStatLine({ receptions: "NA", receiving_yards: "", rushing_yards: "0" });
    expect(line).toEqual({});
  });
});

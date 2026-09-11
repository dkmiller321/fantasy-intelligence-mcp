import { describe, expect, it } from "vitest";
import { fantasyProsPosition, fantasyProsStatsToSleeper } from "../../src/engine/fantasypros-map";
import { scoreStatLine } from "../../src/engine/scoring";
import fixture from "../fixtures/fantasypros/projections-week1.json";
import league from "../fixtures/sleeper/league.json";

const scoring = league.scoring_settings as Record<string, number>;
const byPos = fixture as Record<
  string,
  { players: { name: string; position_id: string; stats: Record<string, number> }[] }
>;

describe("fantasyProsStatsToSleeper, IDP", () => {
  // Jack Campbell, LB, week 1 2026, verbatim from the API. He actually scored 10.28 ppg
  // in 2025, which is what settles the tackle question.
  const campbell = {
    def_sack: 0.16,
    def_int: 0.01,
    def_td: 0.01,
    def_tackle: 7.69,
    def_assist: 4.28,
    def_safety: 0,
    def_ff: 0.13,
    def_fr: 0.11,
    def_pd: 0.25,
    def_tlost: 0,
  };

  it("reads def_tackle as solo tackles, which matches how he actually scores", () => {
    const line = fantasyProsStatsToSleeper(campbell, scoring);
    expect(line.idp_tkl_solo).toBe(7.69);
    expect(line.idp_tkl_ast).toBe(4.28);
    // 7.69(1) + 4.28(.5) + 0.16(3) + 0.01(4) + 0.01(6) + 0.13(2.5) + 0.11(2) + 0.25(1)
    const points = scoreStatLine(line, scoring).points;
    expect(points).toBeCloseTo(11.21, 1);
    // His real 2025 average was 10.28; the combined-tackle reading would give 6.93.
    expect(Math.abs(points - 10.28)).toBeLessThan(Math.abs(6.93 - 10.28));
  });

  it("maps every IDP stat this league scores", () => {
    const line = fantasyProsStatsToSleeper(
      {
        def_tackle: 5,
        def_assist: 2,
        def_sack: 1,
        def_int: 1,
        def_td: 1,
        def_ff: 1,
        def_fr: 1,
        def_pd: 1,
        def_tlost: 1,
        def_safety: 1,
      },
      scoring,
    );
    expect(Object.keys(line).sort()).toEqual([
      "idp_def_td",
      "idp_ff",
      "idp_fum_rec",
      "idp_int",
      "idp_pass_def",
      "idp_sack",
      "idp_safe",
      "idp_tkl_ast",
      "idp_tkl_loss",
      "idp_tkl_solo",
    ]);
  });
});

describe("fantasyProsStatsToSleeper, offence", () => {
  it("maps a receiving line and scores it in league rules", () => {
    // Ja'Marr Chase, verbatim: 7.15 rec, 89.26 yds, 0.69 TD, plus a little rushing.
    const line = fantasyProsStatsToSleeper(
      {
        rec_rec: 7.15,
        rec_yds: 89.26,
        rec_tds: 0.69,
        rush_att: 0.18,
        rush_yds: 0.87,
        fumbles: 0.02,
      },
      scoring,
    );
    // 7.15(.25) + 89.26(.1) + 0.69(6) + 0.87(.1) = 1.7875 + 8.926 + 4.14 + 0.087
    expect(scoreStatLine(line, scoring).points).toBeCloseTo(14.94, 1);
  });

  it("maps a passing line", () => {
    const line = fantasyProsStatsToSleeper(
      { pass_att: 29.05, pass_cmp: 19.32, pass_yds: 234.43, pass_tds: 1.63, pass_ints: 0.45 },
      scoring,
    );
    expect(line.pass_yd).toBe(234.43);
    expect(line.pass_td).toBe(1.63);
    expect(line.pass_int).toBe(0.45);
    // Attempts and completions are volume, not scoring events here.
    expect(line).not.toHaveProperty("pass_att");
  });

  it("treats the fumbles field as fumbles lost", () => {
    expect(fantasyProsStatsToSleeper({ fumbles: 0.2 }, scoring).fum_lost).toBe(0.2);
  });

  it("places undifferentiated field goals in a bucket the league scores, and derives misses", () => {
    const line = fantasyProsStatsToSleeper({ fga: 2.34, fg: 1.97, xpt: 2.73 }, scoring);
    expect(line.fgm_30_39).toBeCloseTo(1.97, 5);
    expect(line.xpm).toBeCloseTo(2.73, 5);
    expect(line.fgmiss).toBeCloseTo(0.37, 5);
  });

  it("ignores keys this league does not score and zero values", () => {
    const line = fantasyProsStatsToSleeper(
      { rush_yds_100: 0, scrimage_yards_200: 0, points_ppr: 22.27, rec_yds: 0 },
      scoring,
    );
    expect(line).toEqual({});
  });

  it("never lets the provider's own points field leak in", () => {
    const line = fantasyProsStatsToSleeper(
      { points: 99, points_ppr: 99, points_half: 99 },
      scoring,
    );
    expect(scoreStatLine(line, scoring).points).toBe(0);
  });
});

describe("recorded fixture", () => {
  it("covers every position this league starts, including IDP", () => {
    for (const pos of ["QB", "RB", "WR", "TE", "K", "LB", "DB", "DL"]) {
      expect(byPos[pos]?.players?.length, `${pos} players`).toBeGreaterThan(0);
    }
  });

  it("every recorded player produces a scoreable line", () => {
    let scored = 0;
    for (const group of Object.values(byPos)) {
      for (const p of group.players) {
        const line = fantasyProsStatsToSleeper(p.stats, scoring);
        if (Object.keys(line).length > 0) {
          expect(scoreStatLine(line, scoring).points).toBeGreaterThan(0);
          scored++;
        }
      }
    }
    expect(scored).toBeGreaterThan(50);
  });
});

describe("fantasyProsPosition", () => {
  it("maps ids onto this league's buckets", () => {
    expect(fantasyProsPosition("QB")).toBe("QB");
    expect(fantasyProsPosition("LB")).toBe("LB");
    expect(fantasyProsPosition("DST")).toBe("DEF");
    expect(fantasyProsPosition("zzz")).toBeNull();
  });
});

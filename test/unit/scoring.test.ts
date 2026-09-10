import { describe, expect, it } from "vitest";
import { inferScoringFormat, scoreStatLine } from "../../src/engine/scoring";
import league from "../fixtures/sleeper/league.json";

const scoring = league.scoring_settings as Record<string, number>;

describe("scoreStatLine", () => {
  it("scores the IDP line that Sleeper reports as 0.15", () => {
    // Justin Strnad, LB, week 1 2026, verbatim from the recorded projection.
    // 1.32 solo x 1 = 1.32
    // 1.83 assist x 0.5 = 0.915
    // 0.15 sack x 3 = 0.45
    // 0.15 pass def x 1 = 0.15
    // 0.31 tkl for loss x 1.5 = 0.465
    // idp_tkl and idp_qb_hit are worth 0 in this league.
    // total = 3.30
    const line = {
      idp_tkl_solo: 1.32,
      idp_tkl_ast: 1.83,
      idp_sack: 0.15,
      idp_pass_def: 0.15,
      idp_tkl_loss: 0.31,
      idp_tkl: 3.15,
      idp_qb_hit: 0.36,
      idp_sack_yd: 0.97,
      pts_ppr: 0.15,
      gp: 1,
    };
    const out = scoreStatLine(line, scoring);
    expect(out.points).toBe(3.3);
    // The provider's own number must not leak into the result.
    expect(out.points).not.toBe(0.15);
    expect(out.contributions[0]?.key).toBe("idp_tkl_solo");
  });

  it("scores a 0.25-PPR receiving line", () => {
    // 5 rec x 0.25 = 1.25; 62 yd x 0.1 = 6.2; 1 TD x 6 = 6  => 13.45
    const out = scoreStatLine({ rec: 5, rec_yd: 62, rec_td: 1 }, scoring);
    expect(out.points).toBe(13.45);
  });

  it("applies the 200-yard receiving bonus when present", () => {
    // 10 rec x 0.25 = 2.5; 205 yd x 0.1 = 20.5; bonus 1 x 3 = 3 => 26.0
    const bonus = scoring.bonus_rec_yd_200 ?? 0;
    const out = scoreStatLine({ rec: 10, rec_yd: 205, bonus_rec_yd_200: 1 }, scoring);
    expect(out.points).toBeCloseTo(2.5 + 20.5 + bonus, 5);
  });

  it("subtracts negative events", () => {
    // 1 int x -1 ... verify against the league's own value rather than assuming.
    const perInt = scoring.pass_int ?? 0;
    const out = scoreStatLine({ pass_int: 2 }, scoring);
    expect(out.points).toBeCloseTo(2 * perInt, 5);
  });

  it("reports unscored keys instead of silently dropping them", () => {
    const out = scoreStatLine({ rec: 1, made_up_stat: 99 }, scoring);
    expect(out.ignoredKeys).toContain("made_up_stat");
    expect(out.points).toBe(0.25);
  });

  it("ignores metadata keys", () => {
    const out = scoreStatLine({ gp: 1, pts_ppr: 20, adp_dd_ppr: 3 }, scoring);
    expect(out.points).toBe(0);
    expect(out.ignoredKeys).toHaveLength(0);
  });
});

describe("inferScoringFormat", () => {
  it("calls this league half-PPR at 0.25 per reception", () => {
    expect(inferScoringFormat(scoring)).toBe("half");
  });

  it("distinguishes full PPR and standard", () => {
    expect(inferScoringFormat({ rec: 1 })).toBe("ppr");
    expect(inferScoringFormat({})).toBe("std");
  });
});

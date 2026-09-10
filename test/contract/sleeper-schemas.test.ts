// Contract tests: the zod schemas must accept responses actually returned by Sleeper.
// Fixtures are recorded verbatim; if Sleeper changes shape these fail loudly.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  leagueSchema,
  leagueUserSchema,
  matchupSchema,
  nflStateSchema,
  projectionRowSchema,
  rosterSchema,
  trendingPlayerSchema,
  userSchema,
} from "../../src/providers/sleeper/schemas";
import league from "../fixtures/sleeper/league.json";
import leagueUsers from "../fixtures/sleeper/league-users.json";
import matchups from "../fixtures/sleeper/matchups-1.json";
import projLb from "../fixtures/sleeper/projections-lb-w1.json";
import projRb from "../fixtures/sleeper/projections-rb-w1.json";
import rosters from "../fixtures/sleeper/rosters.json";
import state from "../fixtures/sleeper/state-nfl.json";
import trending from "../fixtures/sleeper/trending-add.json";
import user from "../fixtures/sleeper/user.json";
import userLeagues from "../fixtures/sleeper/user-leagues.json";

describe("sleeper schemas accept recorded responses", () => {
  it("state/nfl", () => {
    expect(nflStateSchema.parse(state).season).toBe("2026");
  });

  it("user", () => {
    expect(userSchema.parse(user).user_id).toBe("697594890720206848");
  });

  it("user leagues", () => {
    expect(z.array(leagueSchema).parse(userLeagues).length).toBeGreaterThan(0);
  });

  it("league carries IDP roster slots and 0.25 PPR", () => {
    const l = leagueSchema.parse(league);
    expect(l.roster_positions).toContain("IDP_FLEX");
    expect(l.roster_positions).toContain("REC_FLEX");
    expect(l.roster_positions).not.toContain("DEF");
    expect(l.scoring_settings.rec).toBe(0.25);
    expect(l.settings?.playoff_week_start).toBe(14);
  });

  it("rosters", () => {
    const rs = z.array(rosterSchema).parse(rosters);
    expect(rs).toHaveLength(10);
  });

  it("league users", () => {
    expect(z.array(leagueUserSchema).parse(leagueUsers).length).toBe(10);
  });

  it("matchups", () => {
    expect(z.array(matchupSchema).parse(matchups).length).toBe(10);
  });

  it("trending adds", () => {
    expect(z.array(trendingPlayerSchema).parse(trending).length).toBeGreaterThan(0);
  });

  it("projections, offense and IDP", () => {
    const rb = z.array(projectionRowSchema).parse(projRb);
    const lb = z.array(projectionRowSchema).parse(projLb);
    expect(rb.length).toBeGreaterThan(0);
    // IDP projections must carry defensive stat keys, or the engine has nothing to score.
    const withIdp = lb.filter((r) => r.stats && "idp_tkl_solo" in r.stats);
    expect(withIdp.length).toBeGreaterThan(0);
  });
});

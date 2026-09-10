import { describe, expect, it } from "vitest";
import { toLeague, toTeams } from "../../src/jobs/sync-league";
import type { SleeperLeague, SleeperRoster } from "../../src/providers/sleeper/schemas";
import league from "../fixtures/sleeper/league.json";
import rosters from "../fixtures/sleeper/rosters.json";

const raw = league as unknown as SleeperLeague;
const rawRosters = rosters as unknown as SleeperRoster[];

describe("toLeague", () => {
  it("maps the real league, including dynasty and IDP slots", () => {
    const l = toLeague(raw, "3");
    expect(l.numTeams).toBe(10);
    expect(l.isDynasty).toBe(true);
    expect(l.taxiSlots).toBeGreaterThan(0);
    expect(l.waiverType).toBe("faab");
    expect(l.faabBudget).toBe(200);
    expect(l.playoffWeekStart).toBe(14);
    expect(l.rosterPositions.filter((p) => p === "IDP_FLEX")).toHaveLength(4);
    expect(l.myTeamId).toBe("3");
  });

  it("maps Sleeper's waiver_type enum", () => {
    const mk = (n: number) =>
      toLeague({ ...raw, settings: { ...raw.settings, waiver_type: n } }, "1").waiverType;
    expect(mk(2)).toBe("faab");
    expect(mk(1)).toBe("rolling");
    expect(mk(0)).toBe("reverse_standings");
  });

  it("falls back to Sleeper's own defaults when settings are absent", () => {
    const l = toLeague({ ...raw, settings: undefined }, "1");
    expect(l.playoffWeekStart).toBe(15);
    expect(l.playoffTeams).toBe(6);
    expect(l.isDynasty).toBe(false);
  });
});

describe("toTeams", () => {
  it("maps every roster and separates taxi and reserve", () => {
    const teams = toTeams("L1", rawRosters, new Map(), 200);
    expect(teams).toHaveLength(10);
    const mine = teams.find((t) => t.teamId === "3");
    expect(mine?.taxi.length).toBeGreaterThan(0);
    // Taxi and IR players are still in playerIds; callers filter them out.
    expect(mine?.playerIds.length).toBeGreaterThan(mine?.starters.length ?? 0);
  });

  it("recombines Sleeper's split points into one number", () => {
    const teams = toTeams(
      "L1",
      [{ ...(rawRosters[0] as SleeperRoster), settings: { fpts: 120, fpts_decimal: 45 } }],
      new Map(),
      200,
    );
    expect(teams[0]?.record.pointsFor).toBeCloseTo(120.45, 5);
  });

  it("computes FAAB remaining from the budget and what was spent", () => {
    const teams = toTeams(
      "L1",
      [{ ...(rawRosters[0] as SleeperRoster), settings: { waiver_budget_used: 35 } }],
      new Map(),
      200,
    );
    expect(teams[0]?.faabRemaining).toBe(165);
  });

  it("prefers a custom team name over the display name", () => {
    const roster = rawRosters[0] as SleeperRoster;
    const names = new Map([[roster.owner_id as string, "Custom Name"]]);
    expect(toTeams("L1", [roster], names, 200)[0]?.displayName).toBe("Custom Name");
  });

  it("falls back to a roster label when nobody owns the team", () => {
    const orphan = { ...(rawRosters[0] as SleeperRoster), owner_id: null, roster_id: 7 };
    expect(toTeams("L1", [orphan], new Map(), 200)[0]?.displayName).toBe("Team 7");
  });
});

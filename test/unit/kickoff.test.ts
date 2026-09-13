import { describe, expect, it } from "vitest";
import { easternToUtc, hasKickedOff, hoursUntilKickoff } from "../../src/engine/kickoff";

describe("easternToUtc", () => {
  it("reads a September kickoff as Eastern daylight time, not UTC", () => {
    // SF at LA, week 1 2026: 8:35pm ET on the 10th is 00:35 UTC on the 11th.
    const at = easternToUtc("2026-09-10T20:35:00");
    expect(at?.toISOString()).toBe("2026-09-11T00:35:00.000Z");
  });

  it("uses standard time after the November changeover", () => {
    // 1:00pm ET in December is 18:00 UTC, an hour later than the same clock time in
    // September would be.
    const december = easternToUtc("2026-12-06T13:00:00");
    expect(december?.toISOString()).toBe("2026-12-06T18:00:00.000Z");
  });

  it("returns null rather than an invalid date", () => {
    expect(easternToUtc(null)).toBeNull();
    expect(easternToUtc("not a time")).toBeNull();
  });
});

describe("hasKickedOff", () => {
  const sfAtLa = "2026-09-10T20:35:00";

  it("is true two days after the game", () => {
    expect(hasKickedOff(sfAtLa, new Date("2026-09-13T00:02:00Z"))).toBe(true);
  });

  it("is false an hour before", () => {
    expect(hasKickedOff(sfAtLa, new Date("2026-09-10T23:35:00Z"))).toBe(false);
  });

  it("is true exactly at kickoff, when lineups lock", () => {
    expect(hasKickedOff(sfAtLa, new Date("2026-09-11T00:35:00Z"))).toBe(true);
  });

  it("does not lock a game five hours early by misreading the zone", () => {
    // 20:35 UTC on the 10th is still afternoon in Los Angeles; the game has not started.
    expect(hasKickedOff(sfAtLa, new Date("2026-09-10T20:36:00Z"))).toBe(false);
  });

  it("treats an unknown kickoff as not started, so a missing time never hides a player", () => {
    expect(hasKickedOff(null, new Date())).toBe(false);
  });
});

describe("hoursUntilKickoff", () => {
  it("counts down before, and goes negative after", () => {
    const k = "2026-09-13T13:00:00";
    expect(hoursUntilKickoff(k, new Date("2026-09-13T15:00:00Z"))).toBe(2);
    expect(hoursUntilKickoff(k, new Date("2026-09-13T19:00:00Z"))).toBe(-2);
  });
});

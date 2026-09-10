import { describe, expect, it } from "vitest";
import { canonicalFromSleeper, isUnresolved, resolveCanonicalId } from "../../src/ids/canonical";
import { normalizeName, normalizePosition, normalizeTeam } from "../../src/ids/normalize";

describe("resolveCanonicalId", () => {
  const crosswalk = new Map([["4034", "00-0033045"]]);

  it("prefers Sleeper's own gsis_id as first-party data", () => {
    expect(resolveCanonicalId("4034", "00-0099999", crosswalk)).toBe("00-0099999");
  });

  it("falls back to the crosswalk when Sleeper has no gsis_id", () => {
    expect(resolveCanonicalId("4034", null, crosswalk)).toBe("00-0033045");
  });

  it("marks a player unresolved when neither source has an id", () => {
    const id = resolveCanonicalId("99999", null, crosswalk);
    expect(id).toBe(canonicalFromSleeper("99999"));
    expect(isUnresolved(id)).toBe(true);
  });

  it("treats a resolved id as resolved", () => {
    expect(isUnresolved("00-0033045")).toBe(false);
  });
});

describe("normalizePosition", () => {
  it("collapses raw defensive positions into IDP buckets", () => {
    expect(normalizePosition("DE")).toBe("DL");
    expect(normalizePosition("DT")).toBe("DL");
    expect(normalizePosition("NT")).toBe("DL");
    expect(normalizePosition("OLB")).toBe("LB");
    expect(normalizePosition("ILB")).toBe("LB");
    expect(normalizePosition("CB")).toBe("DB");
    expect(normalizePosition("FS")).toBe("DB");
    expect(normalizePosition("SS")).toBe("DB");
  });

  it("keeps offensive positions and folds fullbacks into RB", () => {
    expect(normalizePosition("QB")).toBe("QB");
    expect(normalizePosition("FB")).toBe("RB");
    expect(normalizePosition("PK")).toBe("K");
  });

  it("rejects non-fantasy positions", () => {
    for (const p of ["OL", "OT", "G", "C", "P", "LS"]) {
      expect(normalizePosition(p)).toBeNull();
    }
    expect(normalizePosition(null)).toBeNull();
  });
});

describe("normalizeName", () => {
  it("strips punctuation, case and generational suffixes", () => {
    expect(normalizeName("Marvin Harrison Jr.")).toBe("marvinharrison");
    expect(normalizeName("Ke'Shawn Vaughn")).toBe("keshawnvaughn");
    expect(normalizeName("Robert Griffin III")).toBe("robertgriffin");
  });
});

describe("normalizeTeam", () => {
  it("folds aliases to nflverse convention", () => {
    expect(normalizeTeam("JAC")).toBe("JAX");
    expect(normalizeTeam("WSH")).toBe("WAS");
    expect(normalizeTeam("LAR")).toBe("LA");
    expect(normalizeTeam("OAK")).toBe("LV");
  });

  it("passes through canonical abbreviations and null", () => {
    expect(normalizeTeam("KC")).toBe("KC");
    expect(normalizeTeam(null)).toBeNull();
  });
});

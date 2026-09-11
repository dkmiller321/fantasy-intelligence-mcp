// The sync itself does live HTTP, so this drives the same transformation the sync
// applies -- map, rescore, and the shape stored in D1 -- against the recorded response.

import { describe, expect, it } from "vitest";
import { fantasyProsPosition, fantasyProsStatsToSleeper } from "../../src/engine/fantasypros-map";
import { consensusProjection } from "../../src/engine/project";
import { scoreStatLine } from "../../src/engine/scoring";
import fixture from "../fixtures/fantasypros/projections-week1.json";
import league from "../fixtures/sleeper/league.json";

const scoring = league.scoring_settings as Record<string, number>;
const byPos = fixture as Record<
  string,
  { players: { fpid: number; name: string; position_id: string; stats: Record<string, number> }[] }
>;

/** Exactly what scripts/sync-projections.ts does per player. */
function ingest(stats: Record<string, number>) {
  const line = fantasyProsStatsToSleeper(stats, scoring);
  return { line, points: scoreStatLine(line, scoring).points };
}

describe("FantasyProsend-to-end ingest", () => {
  it("produces a positive projection for every recorded IDP player", () => {
    for (const pos of ["LB", "DB", "DL"]) {
      const players = byPos[pos]?.players ?? [];
      expect(players.length, `${pos} recorded`).toBeGreaterThan(0);
      for (const p of players) {
        const { points } = ingest(p.stats);
        expect(points, `${p.name} (${pos})`).toBeGreaterThan(0);
        // An IDP line that scored under a point would mean the mapping silently dropped
        // the tackle keys, which is the failure worth catching.
        expect(points, `${p.name} (${pos}) looks unmapped`).toBeGreaterThan(1);
      }
    }
  });

  it("gives IDP players a plausible range for this scoring", () => {
    const lb = byPos.LB?.players ?? [];
    const points = lb.map((p) => ingest(p.stats).points);
    // Top-ten linebackers in a 1/0.5 tackle league land roughly between 6 and 20.
    expect(Math.min(...points)).toBeGreaterThan(5);
    expect(Math.max(...points)).toBeLessThan(25);
  });

  it("never lets the provider's own points field through", () => {
    for (const group of Object.values(byPos)) {
      for (const p of group.players) {
        const { line } = ingest(p.stats);
        for (const k of ["points", "points_ppr", "points_half"]) {
          expect(line, `${p.name} leaked ${k}`).not.toHaveProperty(k);
        }
      }
    }
  });

  it("maps every recorded position onto a league slot", () => {
    for (const [pos, group] of Object.entries(byPos)) {
      for (const p of group.players) {
        expect(fantasyProsPosition(p.position_id), `${pos}/${p.name}`).not.toBeNull();
      }
    }
  });

  it("blends with another source and outweighs a single vendor", () => {
    const campbell = byPos.LB?.players.find((p) => p.name === "Jack Campbell");
    expect(campbell, "Jack Campbell in fixture").toBeTruthy();
    const fpPoints = ingest((campbell as { stats: Record<string, number> }).stats).points;

    // Sleeper had him at 8.74 for the same week.
    const blended = consensusProjection([
      { source: "fantasypros", points: fpPoints },
      { source: "sleeper", points: 8.74 },
    ]);
    expect(blended?.sources).toHaveLength(2);
    // FantasyPros carries 0.6 against Sleeper's 0.35, so the blend sits nearer its number.
    const midpoint = (fpPoints + 8.74) / 2;
    expect(blended?.points).toBeGreaterThan(midpoint);
    expect(blended?.points).toBeLessThan(fpPoints);
  });
});

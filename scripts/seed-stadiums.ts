/**
 * Build src/data/stadiums.json: NFL team -> home venue coordinates.
 *
 * Coordinates come from Wikidata rather than being written from memory, per the SPEC's
 * "verify, don't recall" rule. Open-Meteo needs a lat/lng per outdoor game, and nflverse
 * carries a stadium_id but no coordinates.
 *
 *   npm run seed:stadiums
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { csvToObjects, fetchText, naToNull } from "./lib/d1";

const SPARQL = `
SELECT ?teamLabel ?venueLabel ?coord WHERE {
  ?team wdt:P118 wd:Q1215884 .
  ?team wdt:P31 wd:Q17156793 .
  ?team wdt:P115 ?venue .
  ?venue wdt:P625 ?coord .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

const TEAMS_CSV =
  "https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv";

interface Binding {
  teamLabel: { value: string };
  venueLabel: { value: string };
  coord: { value: string };
}

/** Wikidata returns WKT: "Point(lng lat)". */
function parsePoint(wkt: string): { lat: number; lng: number } | null {
  const m = wkt.match(/Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/);
  if (!m) return null;
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

async function main(): Promise<void> {
  const res = await fetch(`https://query.wikidata.org/sparql?query=${encodeURIComponent(SPARQL)}`, {
    headers: {
      accept: "application/sparql-results+json",
      // Wikidata asks for a descriptive agent identifying the caller.
      "user-agent": "fantasy-intelligence-mcp/0.1 (https://github.com/dkmiller321)",
    },
  });
  if (!res.ok) throw new Error(`wikidata: HTTP ${res.status}`);
  const json = (await res.json()) as { results: { bindings: Binding[] } };

  const byTeamName = new Map<string, { venue: string; lat: number; lng: number }>();
  for (const b of json.results.bindings) {
    const name = b.teamLabel.value.trim();
    // Season entities ("2026 Washington Commanders season") share the venue property.
    if (/\bseason\b/i.test(name) || /^\d{4}/.test(name)) continue;
    const point = parsePoint(b.coord.value);
    if (!point) continue;
    byTeamName.set(name, { venue: b.venueLabel.value, ...point });
  }
  console.log(`wikidata teams with venue coordinates: ${byTeamName.size}`);

  const teams = csvToObjects(await fetchText(TEAMS_CSV, "teams_colors_logos.csv"));
  const out: Record<string, { venue: string; lat: number; lng: number }> = {};
  const missing: string[] = [];

  for (const t of teams) {
    const abbr = naToNull(t.team_abbr);
    const name = naToNull(t.team_name);
    if (!abbr || !name) continue;
    // nflverse carries retired abbreviations (STL, SD, OAK) that share a venue with
    // their current name; the alias map in src/ids/normalize.ts folds those already.
    const hit = byTeamName.get(name);
    if (!hit) {
      missing.push(`${abbr} (${name})`);
      continue;
    }
    out[abbr] = hit;
  }

  console.log(`matched ${Object.keys(out).length} teams`);
  if (missing.length > 0) console.log(`unmatched: ${missing.join(", ")}`);

  mkdirSync("src/data", { recursive: true });
  writeFileSync("src/data/stadiums.json", `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log("wrote src/data/stadiums.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

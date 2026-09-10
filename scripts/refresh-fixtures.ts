/**
 * Re-record provider fixtures from the live APIs.
 *
 * Fixtures are the contract tests' evidence that a provider still returns what the zod
 * schemas expect. When a schema starts failing, run this, inspect the diff, and decide
 * whether the provider changed or the code is wrong. Never hand-edit a fixture to make a
 * test pass: that removes the only signal that the upstream shape moved.
 *
 *   npm run fixtures
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { FEEDS } from "../src/providers/news/rss";
import { PROJECTION_POSITIONS } from "../src/providers/sleeper/projections";

const SLEEPER = "https://api.sleeper.app/v1";
const PROJ = "https://api.sleeper.app/projections/nfl";
const USERNAME = "kmills321";
const LEAGUE_ID = "1340893699625717760";

/** Fields Sleeper returns on the user record that should never enter the repository. */
const USER_REDACT = ["email", "phone", "token", "real_name", "verification", "cookies"];

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function write(path: string, value: unknown, pretty = false): void {
  const text = pretty ? JSON.stringify(value, null, 1) : JSON.stringify(value);
  writeFileSync(path, `${text}\n`, "utf8");
  console.log(`  ${path} (${(text.length / 1024).toFixed(1)} KB)`);
}

async function sleeperFixtures(dir: string): Promise<void> {
  console.log("sleeper:");
  const state = await getJson(`${SLEEPER}/state/nfl`);
  write(`${dir}/state-nfl.json`, state);

  const user = (await getJson(`${SLEEPER}/user/${USERNAME}`)) as Record<string, unknown>;
  for (const field of USER_REDACT) if (field in user) user[field] = null;
  write(`${dir}/user.json`, user);

  const userId = String(user.user_id);
  const season = (state as { season: string }).season;
  const week = (state as { week: number }).week;

  write(
    `${dir}/user-leagues.json`,
    await getJson(`${SLEEPER}/user/${userId}/leagues/nfl/${season}`),
  );
  write(`${dir}/league.json`, await getJson(`${SLEEPER}/league/${LEAGUE_ID}`));
  write(`${dir}/rosters.json`, await getJson(`${SLEEPER}/league/${LEAGUE_ID}/rosters`));
  write(`${dir}/league-users.json`, await getJson(`${SLEEPER}/league/${LEAGUE_ID}/users`));
  write(`${dir}/matchups-1.json`, await getJson(`${SLEEPER}/league/${LEAGUE_ID}/matchups/1`));
  write(`${dir}/trending-add.json`, await getJson(`${SLEEPER}/players/nfl/trending/add?limit=25`));

  // A full projection slate is several megabytes. A sample keeps the repository small
  // while still exercising every field the schema declares, offence and IDP alike.
  for (const [position, file] of [
    ["RB", "projections-rb-w1"],
    ["LB", "projections-lb-w1"],
  ] as const) {
    const rows = (await getJson(
      `${PROJ}/${season}/${week}?season_type=regular&position[]=${position}&order_by=ppr`,
    )) as { stats?: Record<string, number> | null }[];
    const withStats = rows.filter((r) => r.stats && Object.keys(r.stats).length > 2).slice(0, 30);
    const without = rows.filter((r) => !r.stats || Object.keys(r.stats).length <= 2).slice(0, 5);
    write(`${dir}/${file}.json`, [...withStats, ...without], true);
  }
}

async function newsFixtures(dir: string): Promise<void> {
  console.log("news:");
  for (const feed of FEEDS) {
    const res = await fetch(feed.url, {
      headers: { accept: "application/rss+xml, application/xml, text/xml" },
    });
    if (!res.ok) {
      console.log(`  ${feed.source}: HTTP ${res.status}, skipped`);
      continue;
    }
    const xml = await res.text();
    const name = feed.source === "profootballtalk" ? "pft" : feed.source.replace("sports", "");
    const path = `${dir}/${name}.xml`;
    writeFileSync(path, xml, "utf8");
    console.log(`  ${path} (${(xml.length / 1024).toFixed(1)} KB)`);
  }
}

async function main(): Promise<void> {
  console.log(`refreshing fixtures (${PROJECTION_POSITIONS.length} projection positions known)`);
  mkdirSync("test/fixtures/sleeper", { recursive: true });
  mkdirSync("test/fixtures/news", { recursive: true });

  await sleeperFixtures("test/fixtures/sleeper");
  await newsFixtures("test/fixtures/news");

  console.log("\ndone. Run `npm test` and review any contract failures before committing:");
  console.log("a failing schema means the provider changed, which is information, not a bug.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

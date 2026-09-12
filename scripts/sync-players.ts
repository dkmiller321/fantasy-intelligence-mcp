/**
 * Sleeper players/nfl -> D1, with canonical ids resolved through the dynastyprocess
 * crosswalk.
 *
 * Runs in Node, not in the Worker: the payload is 14.6 MB across 12,227 players and the
 * free plan allows 10 ms of CPU per cron invocation (DECISIONS D13).
 *
 *   npm run sync:players -- --remote
 */

import type { Position } from "../src/domain/types";
import { canonicalFromSleeper, resolveCanonicalId } from "../src/ids/canonical";
import { normalizeName, normalizePosition, normalizeTeam } from "../src/ids/normalize";
import { csvToObjects, fetchText, loadRows, naToNull, parseArgs, queryD1, sql } from "./lib/d1";

const PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl";
const CROSSWALK_URL = "https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv";

interface SleeperPlayer {
  player_id: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  status?: string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  news_updated?: number | null;
  depth_chart_order?: number | null;
  age?: number | null;
  years_exp?: number | null;
  gsis_id?: string | null;
  espn_id?: number | null;
  yahoo_id?: number | null;
  rotowire_id?: number | null;
  search_full_name?: string | null;
}

/** Sleeper injury_status strings -> the domain enum. */
function mapInjury(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    questionable: "questionable",
    doubtful: "doubtful",
    out: "out",
    ir: "ir",
    "injured reserve": "ir",
    pup: "pup",
    sus: "suspended",
    suspended: "suspended",
    na: "out",
    dnr: "out",
    cov: "out",
  };
  return map[s] ?? "questionable";
}

/**
 * Sleeper reports long-retired players as "Active" — Dominique Rodgers-Cromartie and
 * Jason McCourty both came back that way. A player with no team cannot be rostered
 * whatever the field says, so the team check comes first (DECISIONS D25).
 */
function mapStatus(raw: string | null | undefined, team: string | null): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.includes("practice squad")) return "practice_squad";
  if (!team) return "free_agent";
  if (s === "active") return "active";
  return "inactive";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const remote = Boolean(args.remote);
  const db = "fantasy";
  console.log(`sync-players (${remote ? "remote" : "local"} D1)`);

  const crosswalkCsv = await fetchText(CROSSWALK_URL, "db_playerids.csv");
  const crosswalk = new Map<string, string>();
  // ESPN id -> canonical, kept separately. Sleeper's own espn_id field is sparse for
  // recent players: it matched only 24% of ESPN's projection slate, where the crosswalk
  // matches 94% (DECISIONS D20).
  const espnToCanonical = new Map<string, string>();
  // FantasyPros keys on its own ids and its API cannot enumerate players, so the
  // crosswalk is the only way to ask it about a specific player (DECISIONS D23).
  const fpToCanonical = new Map<string, string>();
  const extIds: string[] = [];

  for (const row of csvToObjects(crosswalkCsv)) {
    const sleeperId = naToNull(row.sleeper_id);
    const gsis = naToNull(row.gsis_id);
    if (sleeperId && gsis) crosswalk.set(sleeperId, gsis);

    const espnId = naToNull(row.espn_id);
    if (espnId && (gsis || sleeperId)) {
      espnToCanonical.set(espnId, gsis ?? canonicalFromSleeper(sleeperId as string));
    }

    const fpId = naToNull(row.fantasypros_id);
    if (fpId && (gsis || sleeperId)) {
      fpToCanonical.set(fpId, gsis ?? canonicalFromSleeper(sleeperId as string));
    }
  }
  console.log(
    `  crosswalk pairs: ${crosswalk.size} sleeper, ${espnToCanonical.size} espn, ${fpToCanonical.size} fantasypros`,
  );

  const playersJson = await fetchText(PLAYERS_URL, "players/nfl");
  const players = JSON.parse(playersJson) as Record<string, SleeperPlayer>;
  const now = new Date().toISOString();

  // Existing state, so only genuine changes are written. Rewriting all ~9,900 players and
  // ~44,000 id rows daily consumed roughly half of D1's 100,000 free daily writes and
  // starved the 15-minute news job, which then failed silently (DECISIONS D22).
  const existingPlayers = new Map<string, string>();
  for (const r of queryD1<{ canonical_id: string; sig: string }>(
    db,
    remote,
    `SELECT canonical_id, name || '|' || COALESCE(team,'') || '|' || status || '|' ||
       COALESCE(injury_status,'') || '|' || COALESCE(injury_body_part,'') || '|' ||
       COALESCE(depth_chart_order,'') || '|' || COALESCE(age,'') AS sig FROM players`,
  )) {
    existingPlayers.set(r.canonical_id, r.sig);
  }
  const existingIds = new Set(
    queryD1<{ k: string }>(
      db,
      remote,
      "SELECT source || '|' || external_id || '|' || canonical_id AS k FROM player_ids",
    ).map((r) => r.k),
  );
  console.log(`  existing: ${existingPlayers.size} players, ${existingIds.size} id rows`);

  const rows: string[] = [];
  let unresolved = 0;
  let considered = 0;
  let unchanged = 0;

  for (const [sleeperId, p] of Object.entries(players)) {
    const fantasyPositions = (p.fantasy_positions ?? [])
      .map(normalizePosition)
      .filter((x): x is Position => x !== null);
    // Only players who can occupy a slot in some league; drops OL, P, LS.
    if (fantasyPositions.length === 0) continue;
    considered++;

    const primary = normalizePosition(p.position) ?? fantasyPositions[0];
    if (!primary) continue;

    const sleeperGsis = naToNull(p.gsis_id);
    const canonicalId = resolveCanonicalId(sleeperId, sleeperGsis, crosswalk);
    if (canonicalId === canonicalFromSleeper(sleeperId)) unresolved++;

    const name = p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
    if (!name) continue;
    const team = normalizeTeam(p.team);
    const injuryUpdated = p.news_updated ? new Date(p.news_updated).toISOString() : null;

    const signature = [
      name,
      team ?? "",
      mapStatus(p.status, team),
      mapInjury(p.injury_status) ?? "",
      p.injury_body_part ?? "",
      p.depth_chart_order ?? "",
      p.age ?? "",
    ].join("|");
    if (existingPlayers.get(canonicalId) === signature) {
      unchanged++;
      continue;
    }

    rows.push(
      `INSERT INTO players (canonical_id, sleeper_id, gsis_id, name, search_name, position,
        fantasy_positions, team, status, injury_status, injury_body_part, injury_note,
        injury_updated_at, bye_week, depth_chart_order, age, years_exp, updated_at, fetched_at)
       VALUES (${sql(canonicalId)}, ${sql(sleeperId)}, ${sql(sleeperGsis ?? crosswalk.get(sleeperId) ?? null)},
        ${sql(name)}, ${sql(p.search_full_name ?? normalizeName(name))}, ${sql(primary)},
        ${sql(JSON.stringify(fantasyPositions))}, ${sql(team)}, ${sql(mapStatus(p.status, team))},
        ${sql(mapInjury(p.injury_status))}, ${sql(p.injury_body_part ?? null)},
        ${sql(p.injury_notes ?? null)}, ${sql(injuryUpdated)}, NULL,
        ${sql(p.depth_chart_order ?? null)}, ${sql(p.age ?? null)}, ${sql(p.years_exp ?? null)},
        ${sql(now)}, ${sql(now)})
       ON CONFLICT(canonical_id) DO UPDATE SET
        sleeper_id=excluded.sleeper_id, gsis_id=excluded.gsis_id, name=excluded.name,
        search_name=excluded.search_name, position=excluded.position,
        fantasy_positions=excluded.fantasy_positions, team=excluded.team,
        status=excluded.status, injury_status=excluded.injury_status,
        injury_body_part=excluded.injury_body_part, injury_note=excluded.injury_note,
        injury_updated_at=excluded.injury_updated_at,
        depth_chart_order=excluded.depth_chart_order, age=excluded.age,
        years_exp=excluded.years_exp, updated_at=excluded.updated_at,
        fetched_at=excluded.fetched_at;`.replace(/\s+/g, " "),
    );

    for (const [source, value] of [
      ["sleeper", sleeperId],
      ["gsis", sleeperGsis ?? crosswalk.get(sleeperId)],
      ["espn", p.espn_id],
      ["yahoo", p.yahoo_id],
      ["rotowire", p.rotowire_id],
    ] as const) {
      if (value === null || value === undefined || value === "") continue;
      if (existingIds.has(`${source}|${String(value)}|${canonicalId}`)) continue;
      extIds.push(
        `INSERT INTO player_ids (canonical_id, source, external_id) VALUES (${sql(canonicalId)}, ${sql(source)}, ${sql(String(value))}) ON CONFLICT(source, external_id) DO UPDATE SET canonical_id=excluded.canonical_id;`,
      );
    }
  }

  // Crosswalk ESPN ids, for players Sleeper did not supply one for.
  let addedEspn = 0;
  for (const [espnId, canonicalId] of espnToCanonical) {
    if (existingIds.has(`espn|${espnId}|${canonicalId}`)) continue;
    extIds.push(
      `INSERT INTO player_ids (canonical_id, source, external_id) VALUES (${sql(canonicalId)}, 'espn', ${sql(espnId)}) ON CONFLICT(source, external_id) DO UPDATE SET canonical_id=excluded.canonical_id;`,
    );
    addedEspn++;
  }
  console.log(`  espn ids from crosswalk: ${addedEspn}`);

  let addedFp = 0;
  for (const [fpId, canonicalId] of fpToCanonical) {
    if (existingIds.has(`fantasypros|${fpId}|${canonicalId}`)) continue;
    extIds.push(
      `INSERT INTO player_ids (canonical_id, source, external_id) VALUES (${sql(canonicalId)}, 'fantasypros', ${sql(fpId)}) ON CONFLICT(source, external_id) DO UPDATE SET canonical_id=excluded.canonical_id;`,
    );
    addedFp++;
  }
  console.log(`  fantasypros ids from crosswalk: ${addedFp}`);

  console.log(`  fantasy-relevant players: ${considered} (${unchanged} unchanged, skipped)`);
  console.log(
    `  unresolved canonical ids: ${unresolved} (${((unresolved / considered) * 100).toFixed(1)}%)`,
  );

  loadRows(rows, { database: db, remote, label: "players", batchSize: 400 });
  loadRows(extIds, { database: db, remote, label: "player_ids", batchSize: 800 });

  const finishedAt = new Date().toISOString();
  loadRows(
    [
      `INSERT INTO ingest_runs (job, started_at, finished_at, status, row_count) VALUES ('sync-players', ${sql(now)}, ${sql(finishedAt)}, 'ok', ${rows.length});`,
    ],
    { database: db, remote, label: "ingest_runs" },
  );
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

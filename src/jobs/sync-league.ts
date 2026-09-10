/**
 * League, roster and standings sync. Unlike players/nfl these payloads are a few KB, so
 * they run inline in a request behind a 5-minute cache (SPEC section 2.7).
 */

import type { League, Team } from "../domain/types";
import type { SleeperProvider } from "../providers/sleeper/client";
import type { SleeperLeague, SleeperRoster } from "../providers/sleeper/schemas";
import { LeagueRepo } from "../storage/d1/leagues";

/** Sleeper waiver_type: 0 reverse standings, 1 rolling, 2 FAAB. */
function mapWaiverType(n: number | undefined): League["waiverType"] {
  if (n === 2) return "faab";
  if (n === 1) return "rolling";
  return "reverse_standings";
}

export function toLeague(raw: SleeperLeague, myTeamId: string): League {
  const s = raw.settings ?? {};
  return {
    id: raw.league_id,
    platform: "sleeper",
    season: Number(raw.season),
    name: raw.name,
    scoring: raw.scoring_settings,
    rosterPositions: raw.roster_positions,
    numTeams: raw.total_rosters,
    // Sleeper omits playoff_week_start on some leagues; 15 is its own default.
    playoffWeekStart: s.playoff_week_start ?? 15,
    playoffTeams: s.playoff_teams ?? 6,
    waiverType: mapWaiverType(s.waiver_type),
    ...(s.waiver_budget !== undefined ? { faabBudget: s.waiver_budget } : {}),
    myTeamId,
    // Sleeper league type: 0 redraft, 1 keeper, 2 dynasty.
    isDynasty: s.type === 2,
    taxiSlots: s.taxi_slots ?? 0,
  };
}

export function toTeams(
  leagueId: string,
  rosters: readonly SleeperRoster[],
  displayNames: ReadonlyMap<string, string>,
  faabBudget: number | undefined,
): Team[] {
  return rosters.map((r) => {
    const s = r.settings ?? {};
    const used = s.waiver_budget_used ?? 0;
    return {
      leagueId,
      teamId: String(r.roster_id),
      ownerUserId: r.owner_id,
      displayName: (r.owner_id ? displayNames.get(r.owner_id) : undefined) ?? `Team ${r.roster_id}`,
      playerIds: r.players ?? [],
      starters: r.starters ?? [],
      taxi: r.taxi ?? [],
      reserve: r.reserve ?? [],
      ...(faabBudget !== undefined ? { faabRemaining: faabBudget - used } : {}),
      record: {
        w: s.wins ?? 0,
        l: s.losses ?? 0,
        t: s.ties ?? 0,
        // Sleeper splits points into integer and decimal parts.
        pointsFor: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100,
      },
    };
  });
}

export interface SyncedLeague {
  league: League;
  teams: Team[];
  myTeam: Team | null;
}

/**
 * Fetch a league and its rosters, persist both, and return them. Idempotent: every
 * write is an upsert on natural keys.
 */
export async function syncLeague(
  sleeper: SleeperProvider,
  db: D1Database,
  leagueId: string,
  sleeperUserId: string,
  now: Date,
): Promise<SyncedLeague> {
  const [raw, rosters, users] = await Promise.all([
    sleeper.getLeague(leagueId),
    sleeper.getRosters(leagueId),
    sleeper.getLeagueUsers(leagueId),
  ]);

  const displayNames = new Map<string, string>();
  for (const u of users) {
    const name = u.metadata?.team_name?.trim() || u.display_name?.trim();
    if (name) displayNames.set(u.user_id, name);
  }

  const mine = rosters.find((r) => r.owner_id === sleeperUserId);
  const myTeamId = mine ? String(mine.roster_id) : "";
  const league = toLeague(raw, myTeamId);
  const teams = toTeams(leagueId, rosters, displayNames, league.faabBudget);

  const repo = new LeagueRepo(db);
  const iso = now.toISOString();
  await repo.upsert(league, iso);
  await repo.upsertTeams(teams, iso);

  return {
    league,
    teams,
    myTeam: teams.find((t) => t.teamId === myTeamId) ?? null,
  };
}

import type { League, Team } from "../../domain/types";

interface LeagueRow {
  id: string;
  season: number;
  name: string;
  scoring: string;
  roster_positions: string;
  num_teams: number;
  playoff_week_start: number;
  playoff_teams: number;
  waiver_type: string;
  faab_budget: number | null;
  my_team_id: string;
  is_dynasty: number;
  taxi_slots: number;
  fetched_at: string;
}

interface TeamRow {
  league_id: string;
  team_id: string;
  owner_user_id: string | null;
  display_name: string;
  player_ids: string;
  starters: string;
  taxi: string;
  reserve: string;
  faab_remaining: number | null;
  wins: number;
  losses: number;
  ties: number;
  points_for: number;
}

function rowToLeague(r: LeagueRow): League {
  return {
    id: r.id,
    platform: "sleeper",
    season: r.season,
    name: r.name,
    scoring: JSON.parse(r.scoring) as Record<string, number>,
    rosterPositions: JSON.parse(r.roster_positions) as string[],
    numTeams: r.num_teams,
    playoffWeekStart: r.playoff_week_start,
    playoffTeams: r.playoff_teams,
    waiverType: r.waiver_type as League["waiverType"],
    ...(r.faab_budget !== null ? { faabBudget: r.faab_budget } : {}),
    myTeamId: r.my_team_id,
    isDynasty: r.is_dynasty === 1,
    taxiSlots: r.taxi_slots,
  };
}

function rowToTeam(r: TeamRow): Team {
  return {
    leagueId: r.league_id,
    teamId: r.team_id,
    ownerUserId: r.owner_user_id,
    displayName: r.display_name,
    playerIds: JSON.parse(r.player_ids) as string[],
    starters: JSON.parse(r.starters) as string[],
    taxi: JSON.parse(r.taxi) as string[],
    reserve: JSON.parse(r.reserve) as string[],
    ...(r.faab_remaining !== null ? { faabRemaining: r.faab_remaining } : {}),
    record: { w: r.wins, l: r.losses, t: r.ties, pointsFor: r.points_for },
  };
}

export class LeagueRepo {
  constructor(private readonly db: D1Database) {}

  async get(leagueId: string): Promise<League | null> {
    const r = await this.db
      .prepare("SELECT * FROM leagues WHERE id = ?")
      .bind(leagueId)
      .first<LeagueRow>();
    return r ? rowToLeague(r) : null;
  }

  async list(): Promise<League[]> {
    const res = await this.db.prepare("SELECT * FROM leagues ORDER BY season DESC, name").all<LeagueRow>();
    return res.results.map(rowToLeague);
  }

  async upsert(l: League, fetchedAt: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO leagues (id, platform, season, name, scoring, roster_positions, num_teams,
           playoff_week_start, playoff_teams, waiver_type, faab_budget, my_team_id,
           is_dynasty, taxi_slots, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           season=excluded.season, name=excluded.name, scoring=excluded.scoring,
           roster_positions=excluded.roster_positions, num_teams=excluded.num_teams,
           playoff_week_start=excluded.playoff_week_start, playoff_teams=excluded.playoff_teams,
           waiver_type=excluded.waiver_type, faab_budget=excluded.faab_budget,
           my_team_id=excluded.my_team_id, is_dynasty=excluded.is_dynasty,
           taxi_slots=excluded.taxi_slots, fetched_at=excluded.fetched_at`,
      )
      .bind(
        l.id,
        l.platform,
        l.season,
        l.name,
        JSON.stringify(l.scoring),
        JSON.stringify(l.rosterPositions),
        l.numTeams,
        l.playoffWeekStart,
        l.playoffTeams,
        l.waiverType,
        l.faabBudget ?? null,
        l.myTeamId,
        l.isDynasty ? 1 : 0,
        l.taxiSlots,
        fetchedAt,
      )
      .run();
  }

  async teams(leagueId: string): Promise<Team[]> {
    const res = await this.db
      .prepare("SELECT * FROM teams WHERE league_id = ? ORDER BY CAST(team_id AS INTEGER)")
      .bind(leagueId)
      .all<TeamRow>();
    return res.results.map(rowToTeam);
  }

  async team(leagueId: string, teamId: string): Promise<Team | null> {
    const r = await this.db
      .prepare("SELECT * FROM teams WHERE league_id = ? AND team_id = ?")
      .bind(leagueId, teamId)
      .first<TeamRow>();
    return r ? rowToTeam(r) : null;
  }

  async upsertTeams(teams: readonly Team[], fetchedAt: string): Promise<void> {
    if (teams.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO teams (league_id, team_id, owner_user_id, display_name, player_ids,
         starters, taxi, reserve, faab_remaining, wins, losses, ties, points_for, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(league_id, team_id) DO UPDATE SET
         owner_user_id=excluded.owner_user_id, display_name=excluded.display_name,
         player_ids=excluded.player_ids, starters=excluded.starters, taxi=excluded.taxi,
         reserve=excluded.reserve, faab_remaining=excluded.faab_remaining,
         wins=excluded.wins, losses=excluded.losses, ties=excluded.ties,
         points_for=excluded.points_for, fetched_at=excluded.fetched_at`,
    );
    await this.db.batch(
      teams.map((t) =>
        stmt.bind(
          t.leagueId,
          t.teamId,
          t.ownerUserId,
          t.displayName,
          JSON.stringify(t.playerIds),
          JSON.stringify(t.starters),
          JSON.stringify(t.taxi),
          JSON.stringify(t.reserve),
          t.faabRemaining ?? null,
          t.record.w,
          t.record.l,
          t.record.t,
          t.record.pointsFor,
          fetchedAt,
        ),
      ),
    );
  }
}

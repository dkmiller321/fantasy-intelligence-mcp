import type { UserPrefs } from "../../domain/types";

export class PrefsRepo {
  constructor(private readonly db: D1Database) {}

  async get(subject: string): Promise<UserPrefs | null> {
    const r = await this.db
      .prepare(
        "SELECT subject, default_league_id, sleeper_username FROM user_prefs WHERE subject = ?",
      )
      .bind(subject)
      .first<{ subject: string; default_league_id: string | null; sleeper_username: string }>();
    if (!r) return null;
    return {
      subject: r.subject,
      ...(r.default_league_id ? { defaultLeagueId: r.default_league_id } : {}),
      sleeperUsername: r.sleeper_username,
    };
  }

  async setDefaultLeague(
    subject: string,
    leagueId: string,
    sleeperUsername: string,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_prefs (subject, default_league_id, sleeper_username, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(subject) DO UPDATE SET
           default_league_id=excluded.default_league_id, updated_at=excluded.updated_at`,
      )
      .bind(subject, leagueId, sleeperUsername, now)
      .run();
  }
}

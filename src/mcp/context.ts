import type { Env } from "../env";
import { SleeperProvider } from "../providers/sleeper/client";
import { IngestRepo } from "../storage/d1/ingest";
import { LeagueRepo } from "../storage/d1/leagues";
import { PlayerRepo } from "../storage/d1/players";
import { PrefsRepo } from "../storage/d1/prefs";

/**
 * Providers and repositories are injected so tools can be exercised against recorded
 * fixtures and a local D1 without network.
 */
export interface ToolContext {
  env: Env;
  now: () => Date;
  sleeper: SleeperProvider;
  players: PlayerRepo;
  leagues: LeagueRepo;
  prefs: PrefsRepo;
  ingest: IngestRepo;
  /** OAuth subject of the caller; "owner" until auth lands in front of /mcp. */
  subject: string;
}

export function toolContext(
  env: Env,
  now: () => Date = () => new Date(),
  subject = "owner",
): ToolContext {
  return {
    env,
    now,
    subject,
    sleeper: new SleeperProvider(now),
    players: new PlayerRepo(env.DB),
    leagues: new LeagueRepo(env.DB),
    prefs: new PrefsRepo(env.DB),
    ingest: new IngestRepo(env.DB),
  };
}

/**
 * Which league a tool call is about: an explicit argument, then the caller's saved
 * default, then the league configured at deploy time.
 */
export async function resolveLeagueId(ctx: ToolContext, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const prefs = await ctx.prefs.get(ctx.subject);
  return prefs?.defaultLeagueId ?? ctx.env.DEFAULT_LEAGUE_ID ?? null;
}

export interface SeasonWeek {
  season: number;
  week: number;
  seasonType: string;
}

export async function resolveSeasonWeek(
  ctx: ToolContext,
  explicitWeek?: number,
): Promise<SeasonWeek> {
  const s = await ctx.sleeper.getNflState();
  return {
    season: Number(s.season),
    week: explicitWeek ?? s.week,
    seasonType: s.season_type,
  };
}

let cachedUserId: { username: string; id: string } | null = null;

/** The owner's Sleeper user id. Stable for the life of the account, so cached in memory. */
export async function sleeperUserId(ctx: ToolContext): Promise<string> {
  const username = ctx.env.SLEEPER_USERNAME;
  if (cachedUserId?.username === username) return cachedUserId.id;
  const user = await ctx.sleeper.getUser(username);
  cachedUserId = { username, id: user.user_id };
  return user.user_id;
}

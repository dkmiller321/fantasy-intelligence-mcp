// Written from fixtures recorded off the live API, not from memory (SPEC section 5).
// Sleeper returns many fields this project ignores; z.object strips them.

import { z } from "zod";

export const nflStateSchema = z.object({
  week: z.number(),
  leg: z.number(),
  season: z.string(),
  season_type: z.string(),
  league_season: z.string(),
  previous_season: z.string(),
  season_start_date: z.string(),
  display_week: z.number(),
});

export const userSchema = z.object({
  user_id: z.string(),
  username: z.string().nullable(),
  display_name: z.string().nullable(),
});

export const leagueSchema = z.object({
  league_id: z.string(),
  name: z.string(),
  season: z.string(),
  status: z.string(),
  sport: z.string(),
  total_rosters: z.number(),
  roster_positions: z.array(z.string()),
  scoring_settings: z.record(z.string(), z.number()),
  previous_league_id: z.string().nullable().optional(),
  settings: z
    .object({
      playoff_week_start: z.number().optional(),
      playoff_teams: z.number().optional(),
      waiver_type: z.number().optional(),
      waiver_budget: z.number().optional(),
      taxi_slots: z.number().optional(),
      // 2 = dynasty/keeper in Sleeper's league type enum.
      type: z.number().optional(),
      num_teams: z.number().optional(),
    })
    .optional(),
});

export const rosterSchema = z.object({
  roster_id: z.number(),
  league_id: z.string(),
  owner_id: z.string().nullable(),
  players: z.array(z.string()).nullable(),
  starters: z.array(z.string()).nullable(),
  taxi: z.array(z.string()).nullable(),
  reserve: z.array(z.string()).nullable(),
  settings: z
    .object({
      wins: z.number().optional(),
      losses: z.number().optional(),
      ties: z.number().optional(),
      fpts: z.number().optional(),
      fpts_decimal: z.number().optional(),
      waiver_budget_used: z.number().optional(),
      waiver_position: z.number().optional(),
    })
    .optional(),
});

export const leagueUserSchema = z.object({
  user_id: z.string(),
  display_name: z.string().nullable(),
  metadata: z.object({ team_name: z.string().optional() }).nullable().optional(),
});

export const matchupSchema = z.object({
  roster_id: z.number(),
  matchup_id: z.number().nullable(),
  points: z.number().nullable(),
  starters: z.array(z.string()).nullable(),
  players: z.array(z.string()).nullable(),
});

export const trendingPlayerSchema = z.object({
  player_id: z.string(),
  count: z.number(),
});

/**
 * Undocumented projections endpoint (DECISIONS.md D6). `stats` carries the stat line;
 * its `pts_ppr` is unreliable for IDP and is deliberately not read.
 */
export const projectionRowSchema = z.object({
  player_id: z.string(),
  week: z.number().nullable(),
  season: z.string(),
  team: z.string().nullable(),
  opponent: z.string().nullable(),
  game_id: z.string().nullable(),
  company: z.string().nullable(),
  stats: z.record(z.string(), z.number()).nullable(),
  player: z
    .object({
      first_name: z.string().nullable(),
      last_name: z.string().nullable(),
      position: z.string().nullable(),
      team_abbr: z.string().nullable(),
      injury_status: z.string().nullable(),
      years_exp: z.number().nullable(),
    })
    .nullable(),
});

export type SleeperNflState = z.infer<typeof nflStateSchema>;
export type SleeperLeague = z.infer<typeof leagueSchema>;
export type SleeperRoster = z.infer<typeof rosterSchema>;
export type SleeperLeagueUser = z.infer<typeof leagueUserSchema>;
export type SleeperMatchup = z.infer<typeof matchupSchema>;
export type SleeperProjectionRow = z.infer<typeof projectionRowSchema>;

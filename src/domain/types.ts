// Domain types. SPEC section 4, extended for IDP (DECISIONS.md D4).

/** Fantasy positions this league can roster. No team DEF slot exists here. */
export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF" | "DL" | "LB" | "DB";

export type InjuryStatus =
  | "healthy"
  | "questionable"
  | "doubtful"
  | "out"
  | "ir"
  | "pup"
  | "suspended";

export type PlayerStatus = "active" | "inactive" | "practice_squad" | "free_agent";

export interface ExternalIds {
  sleeper?: string;
  gsis?: string;
  espn?: string;
  fantasypros?: string;
  pfr?: string;
  yahoo?: string;
  rotowire?: string;
}

export interface Player {
  canonicalId: string;
  externalIds: ExternalIds;
  name: string;
  position: Position;
  team: string | null;
  status: PlayerStatus;
  injury: {
    status: InjuryStatus;
    bodyPart?: string;
    note?: string;
    updatedAt?: string;
  };
  byeWeek: number | null;
  depthChartOrder?: number;
  age?: number;
  yearsExp?: number;
  updatedAt: string;
}

export interface League {
  id: string;
  platform: "sleeper";
  season: number;
  name: string;
  /** Sleeper scoring_settings, keys verbatim. 68 keys in this league, 19 of them IDP. */
  scoring: Record<string, number>;
  rosterPositions: string[];
  numTeams: number;
  playoffWeekStart: number;
  playoffTeams: number;
  waiverType: "faab" | "rolling" | "reverse_standings";
  faabBudget?: number;
  myTeamId: string;
  isDynasty: boolean;
  taxiSlots: number;
}

export interface Team {
  leagueId: string;
  teamId: string;
  ownerUserId: string | null;
  displayName: string;
  playerIds: string[];
  starters: string[];
  /** Dynasty taxi squad; ineligible to start. */
  taxi: string[];
  /** IR / reserve; ineligible to start. */
  reserve: string[];
  faabRemaining?: number;
  record: { w: number; l: number; t: number; pointsFor: number };
}

export interface Game {
  id: string;
  season: number;
  week: number;
  kickoff: string;
  home: string;
  away: string;
  roof: "outdoors" | "dome" | "closed" | "open";
  surface?: string;
  venue?: { name: string; lat: number; lng: number };
  /** Spread is from the home team's perspective. */
  odds?: {
    spread: number;
    total: number;
    impliedHome: number;
    impliedAway: number;
    asOf: string;
  };
  /** Outdoor games only. */
  weather?: { tempF: number; windMph: number; precipProb: number; asOf: string };
}

export interface Projection {
  playerId: string;
  season: number;
  week: number | "ros";
  source: string;
  scoringFormat: "ppr" | "half" | "std" | "league";
  points: number;
  floor?: number;
  ceiling?: number;
  /** Raw provider stat line. Points are recomputed from this (DECISIONS.md D5). */
  statLine?: Record<string, number>;
  asOf: string;
}

export interface PlayerWeekStats {
  playerId: string;
  season: number;
  week: number;
  opponent: string;
  fantasyPoints: number;
  snaps?: number;
  snapShare?: number;
  targets?: number;
  targetShare?: number;
  carries?: number;
  redZoneTouches?: number;
  routes?: number;
  // IDP usage
  tacklesSolo?: number;
  tacklesAssist?: number;
  sacks?: number;
  passesDefended?: number;
}

export interface DefenseVsPosition {
  team: string;
  season: number;
  throughWeek: number;
  position: Position;
  fpaPerGame: number;
  rank: number;
  window: number;
}

export type NewsImpact = "high" | "medium" | "low";

export interface NewsItem {
  id: string;
  dedupeKey: string;
  playerIds: string[];
  source: string;
  title: string;
  summary?: string;
  url?: string;
  impact: NewsImpact;
  publishedAt: string;
  fetchedAt: string;
}

export interface Evidence {
  factor: string;
  value: string | number;
  effect: "+" | "-" | "0";
  note?: string;
}

export type RecommendationType = "start_sit" | "lineup" | "waiver" | "trade" | "playoff";

export interface Recommendation {
  id: string;
  type: RecommendationType;
  leagueId: string;
  week: number;
  playerIds: string[];
  verdict: string;
  confidence: number;
  evidence: Evidence[];
  createdAt: string;
}

export interface UserPrefs {
  subject: string;
  defaultLeagueId?: string;
  sleeperUsername: string;
}

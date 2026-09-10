-- Phase 1 schema. Mirrors src/domain/types.ts.
-- Every row carries fetched_at or as_of so freshness is queryable.

CREATE TABLE IF NOT EXISTS players (
  canonical_id     TEXT PRIMARY KEY,
  sleeper_id       TEXT,
  gsis_id          TEXT,
  name             TEXT NOT NULL,
  search_name      TEXT NOT NULL,
  position         TEXT NOT NULL,
  -- JSON array. Slot eligibility comes from here, not from position
  -- (Von Miller is position LB but fills DL or LB).
  fantasy_positions TEXT NOT NULL DEFAULT '[]',
  team             TEXT,
  status           TEXT NOT NULL,
  injury_status    TEXT,
  injury_body_part TEXT,
  injury_note      TEXT,
  injury_updated_at TEXT,
  bye_week         INTEGER,
  depth_chart_order INTEGER,
  age              INTEGER,
  years_exp        INTEGER,
  updated_at       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_sleeper ON players(sleeper_id);
CREATE INDEX IF NOT EXISTS idx_players_gsis    ON players(gsis_id);
CREATE INDEX IF NOT EXISTS idx_players_search  ON players(search_name);
CREATE INDEX IF NOT EXISTS idx_players_team_pos ON players(team, position);

-- Cross-provider id crosswalk. Sleeper's own gsis_id covers only ~20% of active
-- players, so dynastyprocess db_playerids is the primary bridge (DECISIONS D12).
CREATE TABLE IF NOT EXISTS player_ids (
  canonical_id TEXT NOT NULL,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  PRIMARY KEY (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_player_ids_canonical ON player_ids(canonical_id);

CREATE TABLE IF NOT EXISTS leagues (
  id                 TEXT PRIMARY KEY,
  platform           TEXT NOT NULL DEFAULT 'sleeper',
  season             INTEGER NOT NULL,
  name               TEXT NOT NULL,
  scoring            TEXT NOT NULL,   -- JSON map, Sleeper keys verbatim
  roster_positions   TEXT NOT NULL,   -- JSON array
  num_teams          INTEGER NOT NULL,
  playoff_week_start INTEGER NOT NULL,
  playoff_teams      INTEGER NOT NULL,
  waiver_type        TEXT NOT NULL,
  faab_budget        INTEGER,
  my_team_id         TEXT NOT NULL,
  is_dynasty         INTEGER NOT NULL DEFAULT 0,
  taxi_slots         INTEGER NOT NULL DEFAULT 0,
  fetched_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  league_id     TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  owner_user_id TEXT,
  display_name  TEXT NOT NULL,
  player_ids    TEXT NOT NULL DEFAULT '[]',
  starters      TEXT NOT NULL DEFAULT '[]',
  taxi          TEXT NOT NULL DEFAULT '[]',
  reserve       TEXT NOT NULL DEFAULT '[]',
  faab_remaining INTEGER,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  ties          INTEGER NOT NULL DEFAULT 0,
  points_for    REAL NOT NULL DEFAULT 0,
  fetched_at    TEXT NOT NULL,
  PRIMARY KEY (league_id, team_id)
);

CREATE TABLE IF NOT EXISTS games (
  id           TEXT PRIMARY KEY,
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  kickoff      TEXT,
  home         TEXT NOT NULL,
  away         TEXT NOT NULL,
  roof         TEXT,
  surface      TEXT,
  venue_name   TEXT,
  venue_lat    REAL,
  venue_lng    REAL,
  spread       REAL,          -- home team's perspective
  total        REAL,
  implied_home REAL,
  implied_away REAL,
  odds_as_of   TEXT,
  temp_f       REAL,
  wind_mph     REAL,
  precip_prob  REAL,
  weather_as_of TEXT,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_season_week ON games(season, week);
CREATE INDEX IF NOT EXISTS idx_games_teams ON games(season, week, home, away);

CREATE TABLE IF NOT EXISTS projections (
  player_id      TEXT NOT NULL,
  season         INTEGER NOT NULL,
  week           TEXT NOT NULL,      -- integer week, or 'ros'
  source         TEXT NOT NULL,
  scoring_format TEXT NOT NULL,
  points         REAL NOT NULL,
  floor          REAL,
  ceiling        REAL,
  stat_line      TEXT,               -- JSON; points are recomputed from this
  opponent       TEXT,
  as_of          TEXT NOT NULL,
  PRIMARY KEY (player_id, season, week, source)
);
CREATE INDEX IF NOT EXISTS idx_projections_lookup ON projections(season, week, player_id);

CREATE TABLE IF NOT EXISTS player_week_stats (
  player_id        TEXT NOT NULL,
  season           INTEGER NOT NULL,
  week             INTEGER NOT NULL,
  opponent         TEXT,
  team             TEXT,
  stat_line        TEXT NOT NULL,    -- JSON, nflverse columns
  snaps            REAL,
  snap_share       REAL,
  targets          REAL,
  target_share     REAL,
  carries          REAL,
  routes           REAL,
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (player_id, season, week)
);
CREATE INDEX IF NOT EXISTS idx_pws_season_week ON player_week_stats(season, week);

-- Materialized weekly; never computed in a request (10 ms CPU budget).
CREATE TABLE IF NOT EXISTS defense_vs_position (
  team          TEXT NOT NULL,
  season        INTEGER NOT NULL,
  through_week  INTEGER NOT NULL,
  position      TEXT NOT NULL,
  fpa_per_game  REAL NOT NULL,
  rank          INTEGER NOT NULL,
  window        INTEGER NOT NULL,
  -- Fraction of this row derived from the prior season (DECISIONS D7).
  prior_weight  REAL NOT NULL DEFAULT 0,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (team, season, through_week, position)
);

-- Materialized weekly alongside defense_vs_position.
CREATE TABLE IF NOT EXISTS usage_trends (
  player_id     TEXT NOT NULL,
  season        INTEGER NOT NULL,
  through_week  INTEGER NOT NULL,
  metric        TEXT NOT NULL,      -- snap_share | target_share | carry_share | route_rate
  recent        REAL NOT NULL,
  prior         REAL NOT NULL,
  delta         REAL NOT NULL,
  label         TEXT NOT NULL,      -- rising | flat | falling
  prior_weight  REAL NOT NULL DEFAULT 0,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (player_id, season, through_week, metric)
);

CREATE TABLE IF NOT EXISTS news_items (
  id           TEXT PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  player_ids   TEXT NOT NULL DEFAULT '[]',
  source       TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  impact       TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news_items(published_at DESC);

-- Logged so accuracy can be reviewed after the season.
CREATE TABLE IF NOT EXISTS recommendations (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  league_id  TEXT NOT NULL,
  week       INTEGER NOT NULL,
  player_ids TEXT NOT NULL DEFAULT '[]',
  verdict    TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recs_league_week ON recommendations(league_id, week);

CREATE TABLE IF NOT EXISTS user_prefs (
  subject           TEXT PRIMARY KEY,
  default_league_id TEXT,
  sleeper_username  TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,   -- running | ok | error
  row_count   INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ingest_job ON ingest_runs(job, started_at DESC);

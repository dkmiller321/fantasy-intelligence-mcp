-- Depth chart position and snap share.
--
-- Both were proxied before: waiver "opportunity" used Sleeper's depth_chart_order, and
-- usage trends had no snap data at all, which mattered most for IDP because a defender's
-- scoring is almost entirely a function of how many snaps they play.

-- Latest published depth chart per player. nflverse publishes a time series with several
-- snapshots a day; only the most recent one is kept.
CREATE TABLE IF NOT EXISTS depth_charts (
  player_id   TEXT NOT NULL,
  season      INTEGER NOT NULL,
  team        TEXT NOT NULL,
  -- Positional abbreviation as the team lists it: LDE, MLB, SCB, WR1.
  pos_abb     TEXT NOT NULL,
  pos_name    TEXT,
  pos_grp     TEXT,
  -- 1 is the starter at that spot.
  pos_rank    INTEGER NOT NULL,
  as_of       TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (player_id, season, pos_abb)
);
CREATE INDEX IF NOT EXISTS idx_depth_player ON depth_charts(player_id, season);
CREATE INDEX IF NOT EXISTS idx_depth_team ON depth_charts(season, team, pos_rank);

-- player_week_stats already carries snaps and snap_share columns; they were never
-- populated because the stats release does not include snap counts. This index supports
-- reading a player's snap history without scanning.
CREATE INDEX IF NOT EXISTS idx_pws_player_season ON player_week_stats(player_id, season, week);

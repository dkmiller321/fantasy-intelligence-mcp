export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  OAUTH_KV: KVNamespace;
  SLEEPER_USERNAME: string;
  DEFAULT_LEAGUE_ID: string;
  OWNER_PASSWORD?: string;
  FANTASYPROS_KEY?: string;
  ODDS_API_KEY?: string;
  OPENWEATHER_KEY?: string;
}

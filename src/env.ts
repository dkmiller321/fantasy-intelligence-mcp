import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  /** Required binding name for @cloudflare/workers-oauth-provider. */
  OAUTH_KV: KVNamespace;
  /** Injected into env by the OAuth provider before it calls a handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  SLEEPER_USERNAME: string;
  DEFAULT_LEAGUE_ID: string;
  OWNER_PASSWORD?: string;
  FANTASYPROS_KEY?: string;
  ODDS_API_KEY?: string;
  OPENWEATHER_KEY?: string;
}

import type { Env } from "../env";

/**
 * Per-subject rate limit, so a runaway client cannot exhaust the free tier's daily D1
 * and KV allowances for the owner.
 *
 * A fixed window in KV rather than a sliding one: KV has no atomic increment, and the
 * point here is a backstop against runaway loops, not precise fairness between users.
 * There is exactly one user.
 */

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 60;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function checkRateLimit(
  env: Env,
  subject: string,
  now: Date,
): Promise<RateLimitResult> {
  const window = Math.floor(now.getTime() / 1000 / WINDOW_SECONDS);
  const key = `rl:${subject}:${window}`;

  const current = Number((await env.CACHE.get(key)) ?? "0");
  const resetSeconds = WINDOW_SECONDS - (Math.floor(now.getTime() / 1000) % WINDOW_SECONDS);

  if (current >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetSeconds };
  }

  await env.CACHE.put(key, String(current + 1), { expirationTtl: WINDOW_SECONDS * 2 });
  return { allowed: true, remaining: MAX_REQUESTS - current - 1, resetSeconds };
}

/**
 * One structured line per request. Kept to fields that help diagnose a slow or wrong
 * answer; never the payload, which would leak roster and provider data into logs.
 */
export function logRequest(fields: {
  path: string;
  method: string;
  subject: string;
  status: number;
  ms: number;
  rateLimited?: boolean;
}): void {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      ...fields,
    }),
  );
}

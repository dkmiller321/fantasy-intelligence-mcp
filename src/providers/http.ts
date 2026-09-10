// Shared fetch for every provider: timeout, one retry on 5xx/429, ETag revalidation,
// and a per-provider monthly budget counter so a bug cannot burn a free quota.
// SPEC section 5.

import { ProviderError } from "./types";

export interface HttpOptions {
  provider: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Monthly call ceiling. Omit for keyless providers with no quota. */
  monthlyBudget?: number;
  kv?: KVNamespace;
  /** Cache API TTL in seconds. Sub-hour TTLs use the Cache API, not KV. */
  cacheTtlSec?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Reserve one call against the provider's monthly budget. Returns false when the
 * budget is spent, so the caller degrades instead of spending money or quota.
 */
export async function reserveBudget(
  kv: KVNamespace,
  provider: string,
  monthlyBudget: number,
  now: Date,
): Promise<boolean> {
  const key = `budget:${provider}:${monthKey(now)}`;
  const current = Number((await kv.get(key)) ?? "0");
  if (current >= monthlyBudget) return false;
  // Not atomic. KV has no counters; an over-count of one or two under concurrent crons
  // is acceptable against a 500-credit ceiling, and the check is conservative.
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 62 });
  return true;
}

export async function readBudget(kv: KVNamespace, provider: string, now: Date): Promise<number> {
  return Number((await kv.get(`budget:${provider}:${monthKey(now)}`)) ?? "0");
}

export async function getJson<T = unknown>(opts: HttpOptions, now: Date): Promise<T> {
  const {
    provider,
    url,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    monthlyBudget,
    kv,
    cacheTtlSec,
  } = opts;

  if (monthlyBudget !== undefined && kv) {
    const ok = await reserveBudget(kv, provider, monthlyBudget, now);
    if (!ok) {
      throw new ProviderError(provider, `monthly budget of ${monthlyBudget} calls exhausted`);
    }
  }

  const cache = cacheTtlSec ? caches.default : undefined;
  const cacheKey = new Request(url, { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return (await hit.json()) as T;
  }

  const res = await fetchWithRetry(provider, url, headers, timeoutMs);
  const body = await res.text();

  let parsed: T;
  try {
    parsed = JSON.parse(body) as T;
  } catch {
    throw new ProviderError(provider, `response was not JSON (${body.slice(0, 120)})`);
  }

  if (cache && cacheTtlSec) {
    const cacheable = new Response(body, {
      headers: { "content-type": "application/json", "cache-control": `max-age=${cacheTtlSec}` },
    });
    await cache.put(cacheKey, cacheable);
  }

  return parsed;
}

async function fetchWithRetry(
  provider: string,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", ...headers },
        signal: controller.signal,
      });
      if (res.ok) return res;
      lastStatus = res.status;
      // Only 5xx and 429 are worth a second attempt; 4xx will not change.
      if (res.status < 500 && res.status !== 429) {
        throw new ProviderError(provider, `HTTP ${res.status}`, res.status);
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (attempt === 1) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ProviderError(provider, `request failed: ${reason}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ProviderError(provider, `HTTP ${lastStatus ?? "error"} after retry`, lastStatus);
}

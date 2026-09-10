import type { Env } from "../env";
import { IngestRepo } from "../storage/d1/ingest";
import { syncNews } from "./sync-news";
import { syncWeather } from "./sync-weather";

/**
 * One dispatcher keyed on the cron string (SPEC section 9).
 *
 * Only jobs whose payloads fit in 10 ms of CPU live here. The player list, projections,
 * nflverse stats and the weekly recompute all run in GitHub Actions instead, because
 * their inputs are megabytes (DECISIONS D13). Adding a heavy job here would fail
 * silently every night, so this table is deliberately short rather than aspirational.
 */
export async function runScheduled(cron: string, env: Env, now: Date): Promise<void> {
  const jobs: Record<string, { name: string; run: () => Promise<number> }> = {
    // Three small RSS documents and one batched write.
    "*/15 * * * *": { name: "news-rss", run: () => syncNews(env, now) },
    // Every upcoming outdoor game in a single Open-Meteo request.
    "0 */6 * * *": { name: "weather", run: () => syncWeather(env, now) },
  };

  const job = jobs[cron];
  if (!job) return;

  const ingest = new IngestRepo(env.DB);
  const id = await ingest.start(job.name, now.toISOString());
  try {
    const rows = await job.run();
    await ingest.finish(id, rows, new Date().toISOString());
  } catch (err) {
    await ingest.fail(
      id,
      err instanceof Error ? err.message : String(err),
      new Date().toISOString(),
    );
  }
}

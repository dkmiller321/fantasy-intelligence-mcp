import type { Env } from "../env";
import { IngestRepo } from "../storage/d1/ingest";
import { syncNews } from "./sync-news";
import { syncWeather } from "./sync-weather";

/**
 * One dispatcher keyed on the cron string (SPEC section 9).
 *
 * Only jobs whose payloads fit in 10 ms of CPU live here. The player list, projections,
 * nflverse stats and the weekly recompute all run in GitHub Actions instead, because
 * their inputs are megabytes (DECISIONS D13).
 */
export async function runScheduled(cron: string, env: Env, now: Date): Promise<void> {
  const jobs: Record<string, { name: string; run: () => Promise<number> }> = {
    // Three small RSS documents; headlines already stored are skipped before any matching.
    "*/15 * * * *": { name: "news-rss", run: () => syncNews(env, now) },
    // Every upcoming outdoor game in a single Open-Meteo request.
    "0 */6 * * *": { name: "weather", run: () => syncWeather(env, now) },
  };

  const job = jobs[cron];
  if (!job) return;

  const startedAt = now.toISOString();
  const ingest = new IngestRepo(env.DB);

  try {
    const rows = await job.run();
    await ingest.record({
      job: job.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "ok",
      rowCount: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Logged before the write is attempted: when the failure is D1 being over its write
    // limit, recording it in D1 fails too, and the log line is the only evidence left.
    console.error(JSON.stringify({ at: new Date().toISOString(), job: job.name, error: message }));
    try {
      await ingest.record({
        job: job.name,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "error",
        rowCount: null,
        error: message,
      });
    } catch {
      // Nothing further to do; the log line above is the record.
    }
  }
}

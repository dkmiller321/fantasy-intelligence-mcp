import type { Env } from "../env";
import { IngestRepo } from "../storage/d1/ingest";
import { syncNews } from "./sync-news";
import { syncWeather } from "./sync-weather";

/**
 * One dispatcher keyed on the cron string (SPEC section 9). Only small payloads run
 * here: the free plan allows 10 ms of CPU per cron invocation, so players/nfl and the
 * nflverse files run in GitHub Actions instead (DECISIONS D13).
 */
export async function runScheduled(cron: string, env: Env, now: Date): Promise<void> {
  const ingest = new IngestRepo(env.DB);

  const jobs: Record<string, { name: string; run: () => Promise<number> }> = {
    // Every 15 minutes: breaking news.
    "*/15 * * * *": { name: "news-rss", run: () => syncNews(env, now) },
    // Every 6 hours: weather forecasts for upcoming outdoor games. Betting lines
    // arrive with the nflverse schedule ETL, so no odds provider is needed (D14).
    "0 */6 * * *": { name: "weather", run: () => syncWeather(env, now) },
    // Daily: projections for the current week.
    "0 9 * * *": { name: "projections", run: () => Promise.resolve(0) },
    // Tuesday, after the nflverse ETL lands.
    "0 6 * * 2": { name: "recompute", run: () => Promise.resolve(0) },
  };

  const job = jobs[cron];
  if (!job) return;

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

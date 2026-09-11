/**
 * Job outcomes, read by /health to report freshness.
 *
 * One row per run, written once at the end. The previous shape wrote a "running" row up
 * front and updated it on completion, which failed badly in exactly the situation worth
 * observing: when D1 is over its daily write limit, the opening write succeeds, the job
 * fails, and the closing write fails too, leaving the row stranded at "running" and
 * /health reporting nothing wrong (DECISIONS D22). It also halves the writes these jobs
 * cost, which matters against a shared daily budget.
 */
export interface IngestOutcome {
  job: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "error";
  rowCount: number | null;
  error?: string;
}

export class IngestRepo {
  constructor(private readonly db: D1Database) {}

  async record(o: IngestOutcome): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ingest_runs (job, started_at, finished_at, status, row_count, error)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(
        o.job,
        o.startedAt,
        o.finishedAt,
        o.status,
        o.rowCount,
        o.error ? o.error.slice(0, 500) : null,
      )
      .run();
  }

  /** Most recent successful run per job, for freshness reporting. */
  async latest(): Promise<{ job: string; finishedAt: string; rowCount: number | null }[]> {
    const res = await this.db
      .prepare(
        `SELECT job, MAX(finished_at) AS finished_at, row_count
         FROM ingest_runs WHERE status='ok' GROUP BY job ORDER BY job`,
      )
      .all<{ job: string; finished_at: string; row_count: number | null }>();
    return res.results.map((r) => ({
      job: r.job,
      finishedAt: r.finished_at,
      rowCount: r.row_count,
    }));
  }

  /** Most recent failure per job, so /health can show what is broken rather than only what worked. */
  async failures(): Promise<{ job: string; at: string; error: string | null }[]> {
    const res = await this.db
      .prepare(
        `SELECT job, MAX(finished_at) AS at, error FROM ingest_runs
         WHERE status='error' GROUP BY job ORDER BY job`,
      )
      .all<{ job: string; at: string; error: string | null }>();
    return res.results;
  }
}

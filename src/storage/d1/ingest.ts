/** Every job writes a row here; /health and get_nfl_state read freshness from it. */
export class IngestRepo {
  constructor(private readonly db: D1Database) {}

  async start(job: string, now: string): Promise<number> {
    const r = await this.db
      .prepare(
        "INSERT INTO ingest_runs (job, started_at, status) VALUES (?,?,'running') RETURNING id",
      )
      .bind(job, now)
      .first<{ id: number }>();
    return r?.id ?? 0;
  }

  async finish(id: number, rowCount: number, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE ingest_runs SET finished_at=?, status='ok', row_count=? WHERE id=?")
      .bind(now, rowCount, id)
      .run();
  }

  async fail(id: number, error: string, now: string): Promise<void> {
    await this.db
      .prepare("UPDATE ingest_runs SET finished_at=?, status='error', error=? WHERE id=?")
      .bind(now, error.slice(0, 500), id)
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
}

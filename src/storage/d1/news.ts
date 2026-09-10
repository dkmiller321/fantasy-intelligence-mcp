import type { NewsImpact, NewsItem } from "../../domain/types";

interface NewsRow {
  id: string;
  dedupe_key: string;
  player_ids: string;
  source: string;
  title: string;
  summary: string | null;
  url: string | null;
  impact: string;
  published_at: string;
  fetched_at: string;
}

function toItem(r: NewsRow): NewsItem {
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    playerIds: JSON.parse(r.player_ids) as string[],
    source: r.source,
    title: r.title,
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.url ? { url: r.url } : {}),
    impact: r.impact as NewsImpact,
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
  };
}

const IMPACT_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export class NewsRepo {
  constructor(private readonly db: D1Database) {}

  /** Newest first. With `since` this is the "what changed" feed (SPEC section 3). */
  async recent(opts: {
    since?: string;
    minImpact?: NewsImpact;
    playerIds?: readonly string[];
    limit: number;
  }): Promise<NewsItem[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (opts.since) {
      where.push("published_at > ?");
      params.push(opts.since);
    }
    if (opts.minImpact) {
      const min = IMPACT_RANK[opts.minImpact] ?? 1;
      const allowed = Object.entries(IMPACT_RANK)
        .filter(([, rank]) => rank >= min)
        .map(([name]) => name);
      where.push(`impact IN (${allowed.map(() => "?").join(",")})`);
      params.push(...allowed);
    }
    if (opts.playerIds && opts.playerIds.length > 0) {
      // player_ids is a JSON array; a LIKE on the quoted id avoids a substring match
      // between ids that share a prefix.
      where.push(`(${opts.playerIds.map(() => "player_ids LIKE ?").join(" OR ")})`);
      params.push(...opts.playerIds.map((id) => `%"${id}"%`));
    }

    const sql = `SELECT * FROM news_items
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY published_at DESC LIMIT ?`;
    params.push(opts.limit);

    const res = await this.db
      .prepare(sql)
      .bind(...params)
      .all<NewsRow>();
    return res.results.map(toItem);
  }

  async upsertMany(items: readonly NewsItem[]): Promise<number> {
    if (items.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO news_items (id, dedupe_key, player_ids, source, title, summary, url,
         impact, published_at, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         player_ids=excluded.player_ids, impact=excluded.impact, fetched_at=excluded.fetched_at`,
    );
    await this.db.batch(
      items.map((i) =>
        stmt.bind(
          i.id,
          i.dedupeKey,
          JSON.stringify(i.playerIds),
          i.source,
          i.title,
          i.summary ?? null,
          i.url ?? null,
          i.impact,
          i.publishedAt,
          i.fetchedAt,
        ),
      ),
    );
    return items.length;
  }

  async freshness(): Promise<string | null> {
    const r = await this.db
      .prepare("SELECT MAX(fetched_at) AS t FROM news_items")
      .first<{ t: string | null }>();
    return r?.t ?? null;
  }
}

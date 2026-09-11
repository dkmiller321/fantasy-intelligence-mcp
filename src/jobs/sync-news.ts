import {
  buildNameIndex,
  classifyImpact,
  dedupeKey,
  matchPlayersIndexed,
  type NameIndexEntry,
} from "../engine/news";
import type { Env } from "../env";
import { normalizeName } from "../ids/normalize";
import { RssNewsProvider } from "../providers/news/rss";
import { NewsRepo } from "../storage/d1/news";

/**
 * Pull the RSS feeds, attach players, and store. Runs on the 15-minute cron: three small
 * XML documents and one D1 batch, which fits the free plan's CPU budget where the large
 * ingests do not (DECISIONS D13).
 */
export async function syncNews(env: Env, now: Date): Promise<number> {
  const provider = new RssNewsProvider(() => now);
  const items = await provider.fetchAll();
  if (items.length === 0) return 0;

  // Deduplicate before doing any matching work. Most of a run's ~90 headlines were
  // already stored on the previous run fifteen minutes ago, so in steady state only a
  // handful are new and the expensive path is skipped entirely.
  const seen = new Set<string>();
  const fresh: { item: (typeof items)[number]; key: string }[] = [];
  for (const item of items) {
    const key = dedupeKey(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({ item, key });
  }

  const keys = [...seen];
  const known = new Set<string>();
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90);
    const existing = await env.DB.prepare(
      `SELECT dedupe_key FROM news_items WHERE dedupe_key IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(...chunk)
      .all<{ dedupe_key: string }>();
    for (const r of existing.results) known.add(r.dedupe_key);
  }

  const unseen = fresh.filter((f) => !known.has(f.key));
  if (unseen.length === 0) return 0;

  // Only players who can actually be rostered are matching candidates.
  const res = await env.DB.prepare(
    `SELECT canonical_id, search_name, name, team FROM players
     WHERE status = 'active' AND team IS NOT NULL`,
  ).all<{ canonical_id: string; search_name: string; name: string; team: string }>();

  const entries: NameIndexEntry[] = res.results.map((r) => ({
    canonicalId: r.canonical_id,
    searchName: r.search_name,
    lastName: normalizeName(r.name.split(" ").slice(1).join(" ") || r.name),
    team: r.team,
  }));
  const index = buildNameIndex(entries);

  const iso = now.toISOString();
  const toStore = [];

  for (const { item, key } of unseen) {
    const playerIds = matchPlayersIndexed(item.title, item.description, index);
    toStore.push({
      id: `${item.source}:${key}`.slice(0, 120),
      dedupeKey: key,
      playerIds,
      source: item.source,
      title: item.title,
      ...(item.description ? { summary: item.description.slice(0, 400) } : {}),
      ...(item.link ? { url: item.link } : {}),
      impact: classifyImpact(item.title, item.description),
      publishedAt: item.publishedAt ?? iso,
      fetchedAt: iso,
    });
  }

  return new NewsRepo(env.DB).upsertMany(toStore);
}

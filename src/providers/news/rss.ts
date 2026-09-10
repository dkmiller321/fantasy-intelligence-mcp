import { parseRss, type RawItem } from "../../engine/news";
import type { Provider, ProviderHealth } from "../types";

/**
 * NFL headlines from a small set of public feeds. SPEC section 3 replaces NewsAPI with
 * these because its free tier is delayed and development-only; Sleeper's injury fields
 * remain the authoritative status signal, and these supply the narrative around them.
 *
 * Feed URLs were confirmed live rather than recalled.
 */
export const FEEDS = [
  { source: "espn", url: "https://www.espn.com/espn/rss/nfl/news" },
  { source: "profootballtalk", url: "https://profootballtalk.nbcsports.com/feed/" },
  { source: "cbssports", url: "https://www.cbssports.com/rss/headlines/nfl/" },
] as const;

export interface FetchedItem extends RawItem {
  source: string;
}

export class RssNewsProvider implements Provider {
  readonly name = "rss";

  constructor(private readonly now: () => Date) {}

  async health(): Promise<ProviderHealth> {
    const asOf = this.now().toISOString();
    const items = await this.fetchAll();
    return {
      name: this.name,
      ok: items.length > 0,
      asOf,
      note: `${items.length} items`,
    };
  }

  /**
   * Fetch every feed, tolerating individual failures: one dead feed must not remove
   * news from the other two.
   */
  async fetchAll(): Promise<FetchedItem[]> {
    const results = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const res = await fetch(feed.url, {
          headers: { accept: "application/rss+xml, application/xml, text/xml" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`${feed.source}: HTTP ${res.status}`);
        const xml = await res.text();
        return parseRss(xml).map((item) => ({ ...item, source: feed.source }));
      }),
    );

    const out: FetchedItem[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") out.push(...r.value);
    }
    return out;
  }
}

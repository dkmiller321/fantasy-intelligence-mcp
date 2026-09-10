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

export interface RawItem {
  title: string;
  link: string | null;
  description: string | null;
  publishedAt: string | null;
}

export interface FetchedItem extends RawItem {
  source: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(block: string, name: string): string | null {
  // Namespaced siblings such as <dc:creator> must not satisfy <creator>.
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m?.[1] ? decodeEntities(m[1]) : null;
}

/** Regex rather than a DOM parser: Workers has no XML DOM, and RSS is shallow. */
export function parseRss(xml: string): RawItem[] {
  const out: RawItem[] = [];
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) ?? [];
  for (const block of blocks) {
    const title = tag(block, "title");
    if (!title) continue;
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated");
    const parsed = date ? new Date(date) : null;
    out.push({
      title,
      link: tag(block, "link"),
      description: tag(block, "description"),
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    });
  }
  return out;
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

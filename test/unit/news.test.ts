import { describe, expect, it } from "vitest";
import { classifyImpact, dedupeKey, matchPlayers } from "../../src/engine/news";
import { parseRss } from "../../src/providers/news/rss";
import cbs from "../fixtures/news/cbs.xml?raw";
import espn from "../fixtures/news/espn.xml?raw";
import pft from "../fixtures/news/pft.xml?raw";

const feeds = { espn, pft, cbs };

describe("parseRss against recorded feeds", () => {
  it("extracts items from all three feeds", () => {
    for (const [name, xml] of Object.entries(feeds)) {
      const items = parseRss(xml);
      expect(items.length, `${name} item count`).toBeGreaterThan(5);
      expect(items[0]?.title, `${name} first title`).toBeTruthy();
    }
  });

  it("parses publication dates into ISO timestamps", () => {
    const items = parseRss(feeds.pft);
    const dated = items.filter((i) => i.publishedAt !== null);
    expect(dated.length).toBeGreaterThan(0);
    expect(dated[0]?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("strips CDATA and HTML entities from titles", () => {
    const xml = `<rss><item><title><![CDATA[Smith &amp; Jones "cleared"]]></title>
      <pubDate>Thu, 10 Sep 2026 18:27:35 -0400</pubDate></item></rss>`;
    expect(parseRss(xml)[0]?.title).toBe('Smith & Jones "cleared"');
  });

  it("does not mistake a namespaced tag for the one asked for", () => {
    const xml = `<rss><item><title>Real title</title><dc:creator>Someone</dc:creator></item></rss>`;
    const item = parseRss(xml)[0];
    expect(item?.title).toBe("Real title");
  });

  it("returns nothing for a feed with no items rather than throwing", () => {
    expect(parseRss("<rss><channel></channel></rss>")).toEqual([]);
  });
});

describe("classifyImpact", () => {
  it("flags season-ending and availability news as high", () => {
    expect(classifyImpact("Star WR tore his ACL, out for the season", null)).toBe("high");
    expect(classifyImpact("RB ruled out for Sunday", null)).toBe("high");
    expect(classifyImpact("Team placed him on injured reserve", null)).toBe("high");
    expect(classifyImpact("Veteran TE traded to Buffalo", null)).toBe("high");
  });

  it("flags role and practice news as medium", () => {
    expect(classifyImpact("RB listed as questionable", null)).toBe("medium");
    expect(classifyImpact("Rookie promoted to starter", null)).toBe("medium");
    expect(classifyImpact("He did not practice Wednesday", null)).toBe("medium");
  });

  it("treats everything else as low", () => {
    expect(classifyImpact("Coach praises locker room culture", null)).toBe("low");
  });

  it("reads the description when the headline is vague", () => {
    expect(classifyImpact("Update on the offence", "He is out for the season")).toBe("high");
  });
});

describe("matchPlayers", () => {
  const index = [
    { canonicalId: "a", searchName: "ashtonjeanty", lastName: "jeanty", team: "LV" },
    { canonicalId: "b", searchName: "justinjefferson", lastName: "jefferson", team: "MIN" },
    { canonicalId: "c", searchName: "justinjefferson2", lastName: "jefferson", team: "CLE" },
    { canonicalId: "d", searchName: "jamarrchase", lastName: "chase", team: "CIN" },
  ];

  it("matches a full name in the headline", () => {
    const hits = matchPlayers("Ashton Jeanty says his ankle feels really good", null, index);
    expect(hits).toEqual(["a"]);
  });

  it("refuses to guess when a surname is ambiguous", () => {
    // Two Jeffersons in the index, so a bare surname must not attach to either.
    const hits = matchPlayers("Jefferson expected back this week", null, index);
    expect(hits).toEqual([]);
  });

  it("uses an unambiguous surname when no full name appears", () => {
    expect(matchPlayers("Chase questionable with a hip issue", null, index)).toEqual(["d"]);
  });

  it("returns nothing when no player is mentioned", () => {
    expect(matchPlayers("League announces new kickoff rule", null, index)).toEqual([]);
  });
});

describe("dedupeKey", () => {
  it("collapses the same story published by two feeds", () => {
    expect(dedupeKey("Jeanty ruled OUT for Sunday!")).toBe(
      dedupeKey("jeanty ruled out for sunday"),
    );
  });

  it("keeps different stories distinct", () => {
    expect(dedupeKey("Jeanty ruled out")).not.toBe(dedupeKey("Chase ruled out"));
  });
});

import type { NewsImpact } from "../domain/types";
import { normalizeName } from "../ids/normalize";

/**
 * Player matching and impact classification for news headlines. Pure, so it can be
 * tested against recorded feeds. Parsing the RSS wire format lives with the provider.
 */

/**
 * Keyword rules over the headline. Deliberately conservative: anything that changes
 * whether a player is on the field is high, anything about a role is medium.
 */
const HIGH = [
  "out for the season",
  "season-ending",
  "torn",
  "acl",
  "achilles",
  "ruled out",
  "will not play",
  "placed on ir",
  "injured reserve",
  "suspended",
  "released",
  "traded",
  "carted off",
  "surgery",
  "won't play",
  "doubtful",
];

const MEDIUM = [
  "questionable",
  "limited",
  "did not practice",
  "dnp",
  "expected to play",
  "starter",
  "starting",
  "benched",
  "promoted",
  "activated",
  "return",
  "snap count",
  "workload",
  "committee",
  "depth chart",
  "practice squad",
];

export function classifyImpact(title: string, description: string | null): NewsImpact {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  if (HIGH.some((k) => text.includes(k))) return "high";
  if (MEDIUM.some((k) => text.includes(k))) return "medium";
  return "low";
}

export interface NameIndexEntry {
  canonicalId: string;
  searchName: string;
  lastName: string;
  team: string | null;
}

/**
 * Words of a headline, lowercased and stripped of punctuation but kept separate.
 * `normalizeName` deliberately removes whitespace, which destroys the boundaries needed
 * to reassemble candidate names.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export interface NameIndex {
  byFullName: Map<string, string>;
  /** Surname to canonical id, or null where more than one player shares it. */
  byLastName: Map<string, string | null>;
}

/**
 * Built once per run, then reused for every headline.
 *
 * The previous matcher scanned all ~1,950 players for each of ~90 headlines, which
 * measured 20 ms of CPU on its own against a 10 ms cron budget: the Worker was killed
 * mid-run, so neither the success nor the failure path ever executed and every job row
 * was left at "running" (DECISIONS D22).
 */
export function buildNameIndex(entries: readonly NameIndexEntry[]): NameIndex {
  const byFullName = new Map<string, string>();
  const byLastName = new Map<string, string | null>();

  for (const e of entries) {
    if (e.searchName.length >= 8) byFullName.set(e.searchName, e.canonicalId);
    if (e.lastName.length >= 5) {
      // A surname already present belongs to more than one player, so it identifies
      // nobody. Attaching news to the wrong player is worse than attaching it to none.
      byLastName.set(e.lastName, byLastName.has(e.lastName) ? null : e.canonicalId);
    }
  }

  return { byFullName, byLastName };
}

/**
 * Match by reassembling adjacent words into candidate names and looking them up, rather
 * than testing every player against the text. Names in these feeds are two or three words,
 * so bigrams and trigrams cover them.
 */
export function matchPlayersIndexed(
  title: string,
  description: string | null,
  index: NameIndex,
): string[] {
  const words = normalizeWords(`${title} ${description ?? ""}`);
  const hits = new Set<string>();

  for (let i = 0; i < words.length; i++) {
    const a = words[i] as string;
    const b = words[i + 1];
    const c = words[i + 2];

    if (b !== undefined) {
      const bigram = a + b;
      const hit = index.byFullName.get(bigram);
      if (hit) hits.add(hit);

      if (c !== undefined) {
        const trigram = bigram + c;
        const triHit = index.byFullName.get(trigram);
        if (triHit) hits.add(triHit);
      }
    }
  }
  if (hits.size > 0) return [...hits];

  // No full name present: fall back to surnames that identify exactly one player.
  for (const w of words) {
    const hit = index.byLastName.get(w);
    if (hit) hits.add(hit);
  }
  return [...hits];
}

/**
 * Retained for callers holding a plain list. Builds the index and delegates, so there is
 * one matching implementation rather than two that can drift.
 */
export function matchPlayers(
  title: string,
  description: string | null,
  entries: readonly NameIndexEntry[],
): string[] {
  return matchPlayersIndexed(title, description, buildNameIndex(entries));
}

/** Stable key so the same story from two feeds is stored once. */
export function dedupeKey(title: string): string {
  return normalizeName(title).slice(0, 80);
}

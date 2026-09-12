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

/**
 * Does this headline say whether the player will be on the field?
 *
 * Narrower than `classifyImpact`, and deliberately so. Impact answers "is this worth
 * reading"; this answers "should a lineup decision be revisited right now", which is a
 * much stronger claim and the only thing worth interrupting an answer for.
 *
 * Trades and signings are excluded even though they are high impact, because a headline
 * can mention a player's name as a modifier rather than a subject — "After arriving in
 * the David Montgomery trade, Juice Scruggs is the starting center" is about Scruggs, and
 * raised a false alarm on Montgomery before this existed (DECISIONS D26).
 */
const AVAILABILITY = [
  "ruled out",
  // Present tense too: "Ravens rule out LB Teddye Buchanan" is the same news.
  "rule out",
  "rules out",
  "will miss",
  "miss time",
  "expected to miss",
  // Practice participation, which is how Wednesday and Thursday reports read.
  "limited in practice",
  "did not practice",
  "listed as limited",
  "list ",
  "will not play",
  "won't play",
  "wont play",
  "inactive",
  // In an NFL headline this word is almost always about availability.
  "injury",
  "injuries",
  // Positive availability is worth knowing too: a questionable player confirming.
  "full go",
  "ready to go",
  "doubtful",
  "questionable",
  "injured reserve",
  "placed on ir",
  "to ir",
  "headed to ir",
  "pup list",
  "surgery",
  "torn",
  "acl",
  "achilles",
  "fractured",
  "broken",
  "suspended",
  "suspension",
  "carted off",
  "left the game",
  "exited",
  "released",
  "waived",
  "activated",
  "cleared to play",
  "expected to play",
  "game-time decision",
];

/**
 * "out" needs a word boundary rather than a substring: it appears as a standalone word in
 * "Tagovailoa out, Rush to start" and as part of "throughout" or "outlook" otherwise.
 */
const AVAILABILITY_PATTERNS = [/\bout\b/, /\brule[sd]?\s+out\b/, /\bactivated?\b/];

export function isAvailabilityNews(title: string, _description: string | null): boolean {
  // The headline alone. A name buried in body text is usually incidental, and matching on
  // it is how the false alarms happen.
  const text = title.toLowerCase();
  if (AVAILABILITY.some((k) => text.includes(k))) return true;
  return AVAILABILITY_PATTERNS.some((re) => re.test(text));
}

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

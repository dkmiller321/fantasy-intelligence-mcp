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
 * Match a headline to players by normalized full name, falling back to a surname only
 * when it is unambiguous across the index. Guessing on a shared surname would attach
 * news to the wrong player, which is worse than attaching it to none.
 */
export function matchPlayers(
  title: string,
  description: string | null,
  index: readonly NameIndexEntry[],
): string[] {
  const haystack = normalizeName(`${title} ${description ?? ""}`);
  const hits = new Set<string>();

  for (const entry of index) {
    if (entry.searchName.length >= 8 && haystack.includes(entry.searchName)) {
      hits.add(entry.canonicalId);
    }
  }
  if (hits.size > 0) return [...hits];

  // No full-name hit: try surnames that identify exactly one player.
  const counts = new Map<string, number>();
  for (const e of index) counts.set(e.lastName, (counts.get(e.lastName) ?? 0) + 1);
  for (const entry of index) {
    if (entry.lastName.length < 5) continue;
    if (counts.get(entry.lastName) !== 1) continue;
    if (haystack.includes(entry.lastName)) hits.add(entry.canonicalId);
  }
  return [...hits];
}

/** Stable key so the same story from two feeds is stored once. */
export function dedupeKey(title: string): string {
  return normalizeName(title).slice(0, 80);
}

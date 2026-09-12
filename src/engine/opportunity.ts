import type { InjuryStatus } from "../domain/types";
import { isExcludedByInjury } from "./project";

/**
 * Whether a player's role has just opened up.
 *
 * The waiver score previously inferred this from depth-chart rank alone: being listed
 * first was taken to mean the player ahead was unavailable. That is backwards — it reads
 * the consequence and guesses the cause, and it says nothing at all about the backup whose
 * starter was ruled out an hour ago and who has not yet been re-ranked.
 *
 * This checks the actual thing: who is ahead of this player at their spot, and are any of
 * them out (DECISIONS D27).
 */

export interface DepthEntry {
  canonicalId: string;
  name: string;
  /** Positional slot as the team lists it: RB, LWR, MLB, LDE. */
  posAbb: string;
  /** 1 is the starter at that spot. */
  posRank: number;
  injury: InjuryStatus;
}

export interface Opportunity {
  /** 0-1, feeding the waiver score. */
  score: number;
  /** Players ahead who cannot play, so this player moves up. */
  openedBy: { name: string; injury: InjuryStatus }[];
  /** Players ahead who can play, and are still in the way. */
  blockedBy: string[];
  rank: number | null;
  /** Effective rank once everyone unavailable ahead is removed. */
  effectiveRank: number | null;
}

const NO_OPPORTUNITY: Opportunity = {
  score: 0.2,
  openedBy: [],
  blockedBy: [],
  rank: null,
  effectiveRank: null,
};

/**
 * `sameSpot` is every player listed at the same team and positional slot, including the
 * player themselves. Without a depth-chart entry nothing can be said, so the score falls
 * back to a neutral value rather than pretending to knowledge.
 */
export function roleOpportunity(
  player: DepthEntry | null,
  sameSpot: readonly DepthEntry[],
): Opportunity {
  if (!player) return NO_OPPORTUNITY;

  const ahead = sameSpot.filter(
    (e) => e.posRank < player.posRank && e.canonicalId !== player.canonicalId,
  );
  const openedBy = ahead
    .filter((e) => isExcludedByInjury(e.injury))
    .map((e) => ({ name: e.name, injury: e.injury }));
  const blockedBy = ahead.filter((e) => !isExcludedByInjury(e.injury)).map((e) => e.name);

  // Where they effectively sit once the unavailable are removed.
  const effectiveRank = blockedBy.length + 1;

  let score: number;
  if (player.posRank === 1) {
    // Already the listed starter; the job is theirs regardless of who is hurt.
    score = 1;
  } else if (effectiveRank === 1) {
    // Everyone ahead is out. This is the promotion worth bidding on, and it is invisible
    // to depth-chart rank alone because the chart has not caught up yet.
    score = 0.95;
  } else if (effectiveRank === 2) {
    // One body away. Worth a speculative add, not a real bid.
    score = 0.45;
  } else {
    score = 0.15;
  }

  return { score, openedBy, blockedBy, rank: player.posRank, effectiveRank };
}

/** One line explaining the opportunity, or null when there is nothing to say. */
export function describeOpportunity(o: Opportunity, position: string): string | null {
  if (o.openedBy.length > 0 && o.effectiveRank === 1) {
    const names = o.openedBy.map((p) => `${p.name} (${p.injury})`).join(" and ");
    return `in line to start at ${position} with ${names} unavailable`;
  }
  if (o.openedBy.length > 0) {
    const names = o.openedBy.map((p) => p.name).join(" and ");
    return `moved up at ${position} with ${names} out, but still behind ${o.blockedBy.join(" and ")}`;
  }
  if (o.rank === 1) return `listed first at ${position} on the published depth chart`;
  if (o.effectiveRank === 2) return `next in line at ${position}`;
  return null;
}

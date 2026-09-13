/**
 * Kickoff times, and whether a game has started.
 *
 * Once a game kicks off the roster slot is locked: a player already in the lineup keeps
 * whatever they scored, and a player on the bench can no longer be started. Recommending
 * either is useless, and recommending a bench player whose game has finished is worse
 * than useless because it looks like advice (DECISIONS D28).
 *
 * nflverse stores kickoff as a naive local timestamp in US Eastern, "2026-09-10T20:35:00",
 * with no offset. Parsing that directly treats it as UTC and lands four or five hours
 * early, which would unlock games that have in fact started. The offset is resolved for
 * the actual date rather than hardcoded, because the season crosses the end of daylight
 * saving in early November.
 */

/** Hours to add to an Eastern wall-clock time to get UTC: 4 under EDT, 5 under EST. */
function easternOffsetHours(approximate: Date): number {
  const utc = new Date(approximate.toLocaleString("en-US", { timeZone: "UTC" }));
  const eastern = new Date(approximate.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return Math.round((utc.getTime() - eastern.getTime()) / 3600000);
}

/** A naive Eastern timestamp as a real instant. Null when it cannot be parsed. */
export function easternToUtc(naive: string | null): Date | null {
  if (!naive) return null;
  const asIfUtc = new Date(`${naive.replace(" ", "T")}Z`);
  if (Number.isNaN(asIfUtc.getTime())) return null;
  // The offset is looked up using the approximate instant, which is within hours of the
  // real one and so always falls on the same side of a daylight-saving boundary.
  return new Date(asIfUtc.getTime() + easternOffsetHours(asIfUtc) * 3600000);
}

export function hasKickedOff(kickoff: string | null, now: Date): boolean {
  const at = easternToUtc(kickoff);
  if (!at) return false;
  return at.getTime() <= now.getTime();
}

/** Hours until kickoff; negative once it has started, null when unknown. */
export function hoursUntilKickoff(kickoff: string | null, now: Date): number | null {
  const at = easternToUtc(kickoff);
  if (!at) return null;
  return Math.round(((at.getTime() - now.getTime()) / 3600000) * 10) / 10;
}

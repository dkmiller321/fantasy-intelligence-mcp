/**
 * Canonical player ids.
 *
 * SPEC section 4 says "gsis_id when present, else slp_<sleeperId>". Measured against
 * the live league, Sleeper's own `gsis_id` is populated for only 405 of 1953 active
 * players, and 343 of 421 rostered players lack it — so the naive rule would leave 81%
 * of the league unable to join to nflverse. The dynastyprocess `db_playerids` crosswalk
 * supplies sleeper_id -> gsis_id for the rest and cuts that to 3.1%, all of them 2026
 * rookies with no stat history to join to anyway (DECISIONS D12).
 */

export function canonicalFromGsis(gsis: string): string {
  return gsis;
}

export function canonicalFromSleeper(sleeperId: string): string {
  return `slp_${sleeperId}`;
}

/** True when this id could not be resolved to an NFL-wide identifier. */
export function isUnresolved(canonicalId: string): boolean {
  return canonicalId.startsWith("slp_");
}

/**
 * Resolve one Sleeper player to a canonical id. `crosswalk` maps sleeper_id to
 * gsis_id and comes from `db_playerids`; Sleeper's own field wins when present
 * because it is first-party.
 */
export function resolveCanonicalId(
  sleeperId: string,
  sleeperGsisId: string | null | undefined,
  crosswalk: ReadonlyMap<string, string>,
): string {
  if (sleeperGsisId) return canonicalFromGsis(sleeperGsisId);
  const fromCrosswalk = crosswalk.get(sleeperId);
  if (fromCrosswalk) return canonicalFromGsis(fromCrosswalk);
  return canonicalFromSleeper(sleeperId);
}

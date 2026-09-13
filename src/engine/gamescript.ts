import type { Position } from "../domain/types";

/**
 * What the betting line implies about how a game will be played.
 *
 * The environment multiplier already uses the implied team total, which is about how much
 * scoring a team will do. Game script is a different question: how that scoring gets
 * distributed. A heavy favourite and a heavy underdog can carry the same implied total and
 * produce very different box scores, because trailing teams throw and leading teams run.
 *
 * This deliberately returns context rather than another multiplier. The projections
 * already price the line to some degree, so applying a second adjustment would double
 * count it; and the direction is more useful to a reader than a number would be
 * (DECISIONS D29).
 */

export type ScriptLabel =
  | "heavy favourite"
  | "favourite"
  | "toss-up"
  | "underdog"
  | "heavy underdog";

export interface GameScript {
  /** From this team's perspective. Negative means favoured. */
  spread: number | null;
  total: number | null;
  impliedTeamTotal: number | null;
  label: ScriptLabel | null;
  /** Total well above the slate average: more plays, more scoring, for both sides. */
  shootout: boolean;
  /** Total well below it: fewer possessions, and volume concentrates on starters. */
  grind: boolean;
  /** What this implies for a player at this position, or null when the line is unknown. */
  implication: string | null;
}

export interface ScriptInput {
  /** Spread from the home team's perspective, as nflverse publishes it. */
  homeSpread: number | null;
  total: number | null;
  impliedTeamTotal: number | null;
  isHome: boolean;
  /** Mean total across this week's slate, so "high" is relative to the week. */
  slateMeanTotal: number;
}

/** A touchdown either way is the usual dividing line for one-score game behaviour. */
const HEAVY = 7;
const CLOSE = 3;

export function classifyScript(input: ScriptInput): ScriptLabel | null {
  const { homeSpread, isHome } = input;
  if (homeSpread === null) return null;
  // nflverse publishes the line from the home team's view, positive when home is favoured.
  const spread = isHome ? -homeSpread : homeSpread;
  if (spread <= -HEAVY) return "heavy favourite";
  if (spread < -CLOSE) return "favourite";
  if (spread <= CLOSE) return "toss-up";
  if (spread < HEAVY) return "underdog";
  return "heavy underdog";
}

/**
 * The well-established relationship: teams that lead run the ball and shorten the game,
 * teams that trail throw it. So the same implied total reaches a running back and a
 * receiver very differently depending on which side of the spread they are on.
 */
function implicationFor(
  position: Position,
  label: ScriptLabel,
  shootout: boolean,
  grind: boolean,
): string {
  const passCatcher = position === "WR" || position === "TE" || position === "QB";
  const back = position === "RB";
  const defender = position === "DL" || position === "LB" || position === "DB";

  if (defender) {
    // Defensive scoring follows opponent plays. A trailing opponent throws, which means
    // more snaps and more tackle opportunities for the defence facing them.
    if (label === "heavy favourite") {
      return "their opponent is likely to be trailing and throwing, which means more defensive snaps and tackle chances";
    }
    if (label === "heavy underdog") {
      return "their opponent is likely to be leading and running, which shortens the game and suppresses tackle volume";
    }
    return "a close game keeps both offences balanced, which is neutral for defensive volume";
  }

  if (back) {
    if (label === "heavy favourite") {
      return "as a heavy favourite, late-game carries are likely; rushing volume is the safest path to points here";
    }
    if (label === "heavy underdog") {
      return "likely to be trailing, so carries thin out; receiving work is the realistic path to points";
    }
    if (grind) return "a low total concentrates what scoring there is on the lead back";
    return "a close game keeps the run script intact";
  }

  if (passCatcher) {
    if (label === "heavy underdog") {
      return "trailing teams throw, so attempts should rise even if efficiency drops; this is volume, not comfort";
    }
    if (label === "heavy favourite") {
      return "a comfortable lead can mean fewer second-half pass attempts than the total suggests";
    }
    if (shootout) return "the highest-scoring environment on the slate, with both sides throwing";
    return "a close game should keep the passing script honest";
  }

  // Kickers follow field position and drives more than script.
  if (grind) return "a low total usually means more field-goal attempts than touchdowns";
  if (shootout) return "a high total means drives, though touchdowns cost a kicker points";
  return "nothing unusual in the script here";
}

export function gameScript(position: Position, input: ScriptInput): GameScript {
  const label = classifyScript(input);
  const { total, slateMeanTotal } = input;

  // Relative to the week rather than an absolute number, because totals drift year to year.
  const shootout = total !== null && slateMeanTotal > 0 && total >= slateMeanTotal + 3;
  const grind = total !== null && slateMeanTotal > 0 && total <= slateMeanTotal - 3;

  const spread =
    input.homeSpread === null ? null : input.isHome ? -input.homeSpread : input.homeSpread;

  return {
    spread,
    total,
    impliedTeamTotal: input.impliedTeamTotal,
    label,
    shootout,
    grind,
    implication: label ? implicationFor(position, label, shootout, grind) : null,
  };
}

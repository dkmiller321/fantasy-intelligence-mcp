import type { Position } from "../domain/types";

/**
 * Raw NFL positions collapse into the nine fantasy buckets this league uses.
 * Sleeper already does this in `fantasy_positions`, but nflverse and RSS feeds
 * report raw positions, so both paths need the same mapping.
 */
const POSITION_MAP: Record<string, Position> = {
  QB: "QB",
  RB: "RB",
  FB: "RB",
  WR: "WR",
  TE: "TE",
  K: "K",
  PK: "K",
  DEF: "DEF",
  DST: "DEF",
  // Defensive line
  DL: "DL",
  DE: "DL",
  DT: "DL",
  NT: "DL",
  EDGE: "DL",
  LEO: "DL",
  // Linebackers
  LB: "LB",
  ILB: "LB",
  OLB: "LB",
  MLB: "LB",
  // Defensive backs
  DB: "DB",
  CB: "DB",
  S: "DB",
  FS: "DB",
  SS: "DB",
};

export function normalizePosition(raw: string | null | undefined): Position | null {
  if (!raw) return null;
  return POSITION_MAP[raw.trim().toUpperCase()] ?? null;
}

export function isFantasyPosition(raw: string | null | undefined): boolean {
  return normalizePosition(raw) !== null;
}

/**
 * Name key for last-resort matching when no id crosswalk exists: lowercase,
 * strip punctuation and generational suffixes. Mirrors Sleeper's
 * `search_full_name` so the two agree.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/[^a-z]/g, "");
}

/** Team abbreviations differ across sources; fold to nflverse convention. */
const TEAM_ALIASES: Record<string, string> = {
  JAC: "JAX",
  WSH: "WAS",
  LAR: "LA",
  STL: "LA",
  SD: "LAC",
  OAK: "LV",
  ARZ: "ARI",
  BLT: "BAL",
  CLV: "CLE",
  HST: "HOU",
};

export function normalizeTeam(team: string | null | undefined): string | null {
  if (!team) return null;
  const t = team.trim().toUpperCase();
  return TEAM_ALIASES[t] ?? t;
}

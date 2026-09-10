// SPEC section 6. Every tool returns exactly this shape.

import type { Evidence } from "./types";

export interface Envelope<T> {
  /** 1-3 plain sentences answering the question. No hedging boilerplate. */
  summary: string;
  data: T;
  evidence?: Evidence[];
  /** 0-1, present only on recommendations. */
  confidence?: number;
  caveats: string[];
  sources: { name: string; asOf: string }[];
  meta: {
    season: number;
    week: number;
    leagueId?: string;
    generatedAt: string;
    detail: "brief" | "full";
  };
}

/** One decimal for points, none for percentages (SPEC section 6). */
export function roundPoints(n: number): number {
  return Math.round(n * 10) / 10;
}

export function roundPct(n: number): number {
  return Math.round(n);
}

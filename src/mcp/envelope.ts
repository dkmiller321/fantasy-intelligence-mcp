import type { Envelope } from "../domain/envelope";
import type { Evidence } from "../domain/types";

export interface EnvelopeInit<T> {
  summary: string;
  data: T;
  season: number;
  week: number;
  now: Date;
  leagueId?: string;
  detail?: "brief" | "full";
  evidence?: Evidence[];
  confidence?: number;
  caveats?: string[];
  sources?: { name: string; asOf: string }[];
}

export function envelope<T>(init: EnvelopeInit<T>): Envelope<T> {
  const env: Envelope<T> = {
    summary: init.summary,
    data: init.data,
    caveats: init.caveats ?? [],
    sources: init.sources ?? [],
    meta: {
      season: init.season,
      week: init.week,
      generatedAt: init.now.toISOString(),
      detail: init.detail ?? "brief",
    },
  };
  if (init.leagueId) env.meta.leagueId = init.leagueId;
  if (init.evidence?.length) env.evidence = init.evidence;
  if (init.confidence !== undefined) env.confidence = init.confidence;
  return env;
}

/** Tools return a single text block holding the envelope JSON (SPEC section 6). */
export function toolResult<T>(env: Envelope<T>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(env) }] };
}

/**
 * A failed provider is never an error to the LLM: it is an empty envelope with a
 * caveat saying what broke and what the user can do (SPEC section 6).
 */
export function degraded<T>(
  init: Omit<EnvelopeInit<T>, "summary"> & { summary?: string; failure: string },
) {
  return toolResult(
    envelope({
      ...init,
      summary: init.summary ?? `Could not answer this right now: ${init.failure}`,
      caveats: [...(init.caveats ?? []), init.failure],
    }),
  );
}

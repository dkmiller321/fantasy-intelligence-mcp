import type { Envelope } from "../domain/envelope";
import { envelope, toolResult } from "./envelope";

/**
 * SPEC section 6: a tool must never hand the LLM a bare error. Individual tools already
 * catch the failures they anticipate; this is the backstop for the ones they do not —
 * a D1 outage, a schema change, a bug — so the caller always receives a valid envelope
 * naming what broke.
 */
export function safeHandler<A>(
  toolName: string,
  now: () => Date,
  handler: (args: A) => Promise<{ content: { type: "text"; text: string }[] }>,
): (args: A) => Promise<{ content: { type: "text"; text: string }[] }> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallback: Envelope<null> = envelope({
        summary: `${toolName} could not complete: ${reason}`,
        data: null,
        season: 0,
        week: 0,
        now: now(),
        caveats: [
          `${toolName} failed with: ${reason}`,
          "This is a server-side fault, not a fantasy conclusion. Do not infer anything " +
            "about the player or league from it; retry, or use another tool.",
        ],
      });
      return toolResult(fallback);
    }
  };
}

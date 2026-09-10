export interface ProviderHealth {
  name: string;
  ok: boolean;
  asOf: string;
  note?: string;
}

/** Every adapter implements this much. SPEC section 5. */
export interface Provider {
  readonly name: string;
  health(): Promise<ProviderHealth>;
}

/** Thrown only inside the provider layer. Tools convert it to a caveat, never a 500. */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = "ProviderError";
  }
}

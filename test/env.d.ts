/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Fixtures are imported as raw strings; tests run inside the Workers runtime and have
// no host filesystem.
declare module "*?raw" {
  const content: string;
  export default content;
}

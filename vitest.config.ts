import { readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run against a real (local) D1 with the project's migrations applied, so
// repository SQL is exercised rather than mocked.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        bindings: { TEST_MIGRATIONS: migrations, OWNER_PASSWORD: "test-password" },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});

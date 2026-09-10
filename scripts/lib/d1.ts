export * from "./csv";

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolved via package.json because wrangler's "exports" map hides ./bin.
const WRANGLER_BIN = join(
  createRequire(import.meta.url).resolve("wrangler/package.json"),
  "..",
  "bin",
  "wrangler.js",
);

export interface LoadOptions {
  database: string;
  remote: boolean;
  /** Rows per INSERT. D1 rejects very large single statements. */
  batchSize?: number;
  label: string;
}

/**
 * Load rows by writing batched INSERT statements to a temp .sql file and handing it to
 * `wrangler d1 execute`. Chosen over the D1 HTTP API because it reuses the operator's
 * existing wrangler credentials and needs no separate API token locally.
 */
export function loadRows(rows: readonly string[], opts: LoadOptions): number {
  if (rows.length === 0) {
    console.log(`  ${opts.label}: nothing to load`);
    return 0;
  }
  const batchSize = opts.batchSize ?? 500;
  const dir = mkdtempSync(join(tmpdir(), "d1load-"));
  let loaded = 0;

  try {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const file = join(dir, `batch-${i}.sql`);
      writeFileSync(file, `${batch.join("\n")}\n`, "utf8");

      const args = ["wrangler", "d1", "execute", opts.database, `--file=${file}`, "-y"];
      if (opts.remote) args.push("--remote");
      else args.push("--local");

      execFileSync("npx", args, {
        stdio: ["ignore", "ignore", "pipe"],
        shell: process.platform === "win32",
      });
      loaded += batch.length;
      process.stdout.write(`\r  ${opts.label}: ${loaded}/${rows.length}`);
    }
    process.stdout.write("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return loaded;
}

export async function fetchText(url: string, label: string): Promise<string> {
  process.stdout.write(`  fetching ${label} ... `);
  // Long D1 loads sit between fetches and the connection is often reset by then, so a
  // transient failure here is expected rather than exceptional.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      const text = await res.text();
      console.log(`${(text.length / 1024 / 1024).toFixed(1)} MB`);
      return text;
    } catch (err) {
      lastErr = err;
      process.stdout.write(`retry ${attempt + 1} ... `);
    }
  }
  throw new Error(`${label}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** Read rows back out of D1 for scripts that need existing ids to join against. */
export function queryD1<T = Record<string, unknown>>(
  database: string,
  remote: boolean,
  command: string,
): T[] {
  // wrangler's JS entry is invoked directly, without a shell: `--command` holds spaces
  // and cmd.exe would word-split it, while `--file` routes SELECTs through D1's import
  // API, which rejects them.
  const args = [WRANGLER_BIN, "d1", "execute", database, "--command", command, "-y", "--json"];
  args.push(remote ? "--remote" : "--local");
  const out = execFileSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = out.indexOf("[");
  if (start < 0) return [];
  const parsed = JSON.parse(out.slice(start)) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

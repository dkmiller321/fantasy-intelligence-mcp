export * from "./csv";

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

      execFileSync("npx", args, { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" });
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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const text = await res.text();
  console.log(`${(text.length / 1024 / 1024).toFixed(1)} MB`);
  return text;
}

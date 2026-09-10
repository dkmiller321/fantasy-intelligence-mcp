// Pure parsing helpers. Deliberately free of node: imports so Worker-side tests can
// import them without dragging Node builtins into the Workers typecheck.

/** SQLite string literal. D1 takes no bound parameters through `d1 execute --file`. */
export function sql(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * nflverse and dynastyprocess files are R exports, which write missing values as the
 * literal string "NA". Treating that as data silently collapsed ~200 players onto a
 * single canonical id of "NA" on the first load, so every reader must go through this.
 */
export function naToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "" || v === "NA" || v === "NULL" || v === "null" || v === "N/A") return null;
  return v;
}

/** Minimal RFC4180 CSV reader; nflverse and dynastyprocess files are standard. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let val = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          val += '"';
          i++;
        } else quoted = false;
      } else val += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cur.push(val);
      val = "";
    } else if (c === "\n") {
      cur.push(val);
      rows.push(cur);
      cur = [];
      val = "";
    } else if (c !== "\r") val += c;
  }
  if (val !== "" || cur.length > 0) {
    cur.push(val);
    rows.push(cur);
  }
  return rows;
}

export function csvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return [];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const o: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) o[header[c] as string] = r[c] ?? "";
    out.push(o);
  }
  return out;
}

export function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

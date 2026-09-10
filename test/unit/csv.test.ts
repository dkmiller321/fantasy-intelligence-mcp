import { describe, expect, it } from "vitest";
import { csvToObjects, naToNull, parseCsv } from "../../scripts/lib/csv";

describe("naToNull", () => {
  // nflverse and dynastyprocess are R exports. Accepting "NA" as a value collapsed
  // roughly 200 players onto a single canonical id of "NA" on the first real load.
  it("treats R's missing-value sentinel as missing", () => {
    expect(naToNull("NA")).toBeNull();
    expect(naToNull("N/A")).toBeNull();
    expect(naToNull("NULL")).toBeNull();
    expect(naToNull("")).toBeNull();
    expect(naToNull("   ")).toBeNull();
    expect(naToNull(null)).toBeNull();
    expect(naToNull(undefined)).toBeNull();
  });

  it("keeps real ids, including ones that merely contain NA", () => {
    expect(naToNull("00-0033045")).toBe("00-0033045");
    expect(naToNull(" 4034 ")).toBe("4034");
    expect(naToNull("NATE")).toBe("NATE");
  });
});

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas and escaped quotes", () => {
    const rows = parseCsv('a,b,c\n1,"x,y","he said ""hi"""\n');
    expect(rows[1]).toEqual(["1", "x,y", 'he said "hi"']);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n");
    expect(rows[1]).toEqual(["1", "2"]);
  });
});

describe("csvToObjects", () => {
  it("maps header columns onto each row", () => {
    const objs = csvToObjects("sleeper_id,gsis_id\n4034,00-0033045\nNA,NA\n");
    expect(objs).toHaveLength(2);
    expect(objs[0]).toEqual({ sleeper_id: "4034", gsis_id: "00-0033045" });
    // The sentinel survives parsing; callers must run it through naToNull.
    expect(objs[1]?.sleeper_id).toBe("NA");
    expect(naToNull(objs[1]?.sleeper_id)).toBeNull();
  });
});

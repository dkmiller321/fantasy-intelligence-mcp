import { readFileSync } from "node:fs";
const l = readFileSync("SECRETS.local.md", "utf8").split(/\r?\n/).find((x) => /fantasypros api key/i.test(x));
const K = (l ?? "").split(":").slice(1).join(":").trim();
const r = await fetch("https://api.fantasypros.com/public/v2/json/nfl/2026/projections?position=LB&week=1", {
  headers: { "x-api-key": K, accept: "application/json" },
});
console.log(r.status);

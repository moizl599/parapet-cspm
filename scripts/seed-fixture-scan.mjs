// Seed a completed scan into ./scans from the committed OCSF fixture, so the
// running app can be exercised end-to-end (GET findings + POST analyze) without
// live AWS credentials. Usage: node --import ./scripts/register-alias.mjs scripts/seed-fixture-scan.mjs [scanId]
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { normalizeFindings, summarizeFindings } from "@/lib/ocsf";

const id = process.argv[2] || "fixture-e2e";
const fixture = JSON.parse(
  readFileSync("src/lib/__fixtures__/sample.ocsf.json", "utf8"),
);
const { findings, dropped } = normalizeFindings(fixture);
const summary = summarizeFindings(findings);

const dir = `scans/${id}`;
mkdirSync(dir, { recursive: true });
const now = new Date().toISOString();
writeFileSync(
  `${dir}/status.json`,
  JSON.stringify(
    { scanId: id, status: "done", createdAt: now, updatedAt: now },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  `${dir}/result.json`,
  JSON.stringify({ findings, summary, dropped }, null, 2) + "\n",
);
console.log(
  `seeded scans/${id}: ${findings.length} findings, ${summary.totalFailed} failed, ${dropped} dropped`,
);

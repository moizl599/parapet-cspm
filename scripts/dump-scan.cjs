// Dump a scan's status, findings, and latest analysis from the container DB.
// Run INSIDE the web container from /app: node /app/dump-scan.cjs <scanId>
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "/app/data/cspm.db");
const id = process.argv[2];

const scan = db.prepare("SELECT * FROM scans WHERE id = ?").get(id);
if (!scan) {
  console.log("SCAN NOT FOUND:", id);
  process.exit(0);
}
console.log("STATUS:", scan.status, scan.error ? "| error: " + scan.error : "");

const findings = db
  .prepare(
    "SELECT check_id, title, service, severity, status, resource_id FROM findings WHERE scan_id = ? ORDER BY severity, service",
  )
  .all(id);
console.log("FINDINGS:", findings.length, "total,", findings.filter((f) => f.status === "fail").length, "failed");
for (const f of findings) {
  console.log(`  [${f.severity}/${f.status}] ${f.check_id} | ${f.resource_id}`);
}

const a = db
  .prepare("SELECT posture_score, executive_summary, items FROM analyses WHERE scan_id = ? ORDER BY created_at DESC LIMIT 1")
  .get(id);
if (!a) {
  console.log("ANALYSIS: none yet");
} else {
  console.log("POSTURE_SCORE:", a.posture_score);
  console.log("EXEC_SUMMARY:", (a.executive_summary || "").slice(0, 220));
  const items = JSON.parse(a.items || "[]");
  console.log("TOP_ITEMS:");
  items.slice(0, 3).forEach((it, i) =>
    console.log(`  ${i + 1}. [${it.severity}/rank ${it.priority_rank}] ${it.title}`),
  );
}

const Database = require("better-sqlite3");
const db = new Database("/app/data/cspm.db", { readonly: true });

const rows = db
  .prepare(
    `SELECT s.id, s.environment_id, e.name AS env, s.status, s.analysis_status,
            s.started_at, (SELECT count(*) FROM findings f WHERE f.scan_id = s.id) AS findings
     FROM scans s JOIN environments e ON e.id = s.environment_id
     ORDER BY s.started_at DESC`,
  )
  .all();
console.log("scans:", JSON.stringify(rows, null, 2));

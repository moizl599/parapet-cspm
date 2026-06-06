// Insert a 'role' environment directly into the container's SQLite DB so a role
// scan can be driven without the (Phase 9) environments UI. Run INSIDE the web
// container from /app: node /app/seed-role-env.cjs <name> <accountId> <roleArn> <externalId> <regionsCSV>
const Database = require("better-sqlite3");
const { randomUUID } = require("node:crypto");

const [name, accountId, roleArn, externalId, regionsCsv] = process.argv.slice(2);
const db = new Database(process.env.DB_PATH || "/app/data/cspm.db");
const id = randomUUID();
const regions = (regionsCsv || "").split(",").map((r) => r.trim()).filter(Boolean);

db.prepare(
  `INSERT INTO environments
     (id, name, target_account_id, auth_mode, role_arn, external_id, regions, created_at)
   VALUES (?, ?, ?, 'role', ?, ?, ?, ?)`,
).run(id, name, accountId || null, roleArn, externalId, JSON.stringify(regions), Date.now());

console.log(id);

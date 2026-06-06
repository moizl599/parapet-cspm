/**
 * SQLite connection (SERVER-SIDE ONLY).
 *
 * Driver: better-sqlite3 + Drizzle. The connection is a lazy singleton so
 * importing this module never opens the DB (safe during build/trace) — the file
 * is opened on first `getDb()`.
 *
 * The DB file lives at `${DATA_DIR}/cspm.db` (DATA_DIR defaults to ./data, which
 * is /app/data in the container, backed by the ./data volume).
 *
 * NOTE: if the Alpine native build of better-sqlite3 becomes unworkable, this is
 * the ONE file to swap to Node 24's built-in `node:sqlite` (Drizzle has a
 * matching driver) — the schema and repository layer are driver-agnostic.
 */
import "server-only";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "@/lib/db/schema";

function resolveDbPath(): string {
  const configured = process.env.DATA_DIR?.trim();
  const dataDir = configured && configured.length > 0
    ? configured
    : path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "cspm.db");
}

let db: BetterSQLite3Database<typeof schema> | null = null;
let connection: Database.Database | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (!db) {
    connection = new Database(resolveDbPath());
    connection.pragma("journal_mode = WAL");
    connection.pragma("foreign_keys = ON");
    db = drizzle(connection, { schema });
  }
  return db;
}

/** The raw better-sqlite3 connection (used by the migrator). */
export function getConnection(): Database.Database {
  getDb();
  return connection as Database.Database;
}

/** Close the connection and reset the singleton (used by tests). */
export function closeDb(): void {
  if (connection) {
    connection.close();
    connection = null;
    db = null;
  }
}

export { schema };

/**
 * Idempotent migration runner (SERVER-SIDE ONLY). Drizzle tracks applied
 * migrations in `__drizzle_migrations`, so running this repeatedly is safe; the
 * in-process flag avoids re-walking the folder on every call.
 *
 * Invoked once on server start from `src/instrumentation.ts`.
 */
import "server-only";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "@/lib/db/client";

let done = false;

export function runMigrations(): void {
  if (done) return;
  migrate(getDb(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
  done = true;
}

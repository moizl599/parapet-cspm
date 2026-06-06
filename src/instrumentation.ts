/**
 * Next.js instrumentation: `register()` runs once when a server instance starts
 * (before it serves requests). We use it to apply DB migrations idempotently.
 *
 * Guarded to the Node.js runtime so the Edge runtime never loads better-sqlite3,
 * and so it does not run during `next build` (NEXT_RUNTIME is unset there).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrations } = await import("@/lib/db/migrate");
    runMigrations();
    console.log("[db] migrations applied");

    // Crash safety: a scan/analysis left "running" belongs to a dead process —
    // mark it errored so nothing is stuck forever (the user can re-run).
    const { recoverInterrupted, reconcileAnalysisStatus } = await import(
      "@/lib/db/repository"
    );
    const recovered = recoverInterrupted();
    if (recovered.scans > 0 || recovered.analyses > 0) {
      console.log(
        `[db] recovered interrupted: ${recovered.scans} scan(s), ${recovered.analyses} analysis(es)`,
      );
    }
    // Backfill analysis_status for completed analyses predating this column.
    const reconciled = reconcileAnalysisStatus();
    if (reconciled > 0) {
      console.log(`[db] reconciled ${reconciled} analysis status(es) to done`);
    }
  }
}

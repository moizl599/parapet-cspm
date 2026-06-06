/**
 * Analysis background jobs (SERVER-SIDE ONLY).
 *
 * The LLM analysis is a long-running (minutes) job that must survive client
 * disconnects. It runs as an in-process, fire-and-forget task that writes
 * progress + the final report to SQLite (the source of truth) — closing the
 * browser never stops it. HTTP clients only *observe*: GET /api/scan/[id] polls
 * the persisted state, and POST /api/analyze/[id] optionally tails live tokens
 * by subscribing here. This is appropriate for a single-user local tool on a
 * long-lived standalone Node server.
 */
import "server-only";

import { analyzeFindings, type Analysis } from "@/lib/analyze";
import { getOllamaConfig } from "@/lib/config";
import { summarizeFindings, type FindingsSummary } from "@/lib/ocsf";
import {
  getFindingsForScan,
  getScan,
  saveAnalysis,
  updateAnalysisProgress,
  updateAnalysisStatus,
} from "@/lib/db/repository";

export type AnalysisJobEvent =
  | { type: "token"; value: string }
  | { type: "progress"; completed: number; total: number }
  | { type: "done"; analysis: Analysis }
  | { type: "error"; error: string };

type Listener = (event: AnalysisJobEvent) => void;

interface Job {
  listeners: Set<Listener>;
  promise: Promise<void>;
}

/** Injectable for tests so analysis runs without a live model. */
export interface AnalysisJobDeps {
  analyze?: typeof analyzeFindings;
  model?: string;
}

const jobs = new Map<string, Job>();

export function isAnalysisRunning(scanId: string): boolean {
  return jobs.has(scanId);
}

function broadcast(scanId: string, event: AnalysisJobEvent): void {
  const job = jobs.get(scanId);
  if (!job) return;
  for (const listener of job.listeners) {
    try {
      listener(event);
    } catch {
      /* a faulty subscriber must never affect the job */
    }
  }
}

/**
 * Subscribe to a RUNNING job's live events. Returns an unsubscribe fn, or null
 * if no job is running (the caller should read the persisted result instead).
 * Unsubscribing NEVER stops the job.
 */
export function subscribeToAnalysis(
  scanId: string,
  listener: Listener,
): (() => void) | null {
  const job = jobs.get(scanId);
  if (!job) return null;
  job.listeners.add(listener);
  return () => {
    job.listeners.delete(listener);
  };
}

/**
 * Start (or attach to) the analysis job for a scan. Idempotent: if one is
 * already running, returns its promise. The returned promise resolves when the
 * job settles — used by tests; production callers fire-and-forget.
 */
export function startAnalysis(
  scanId: string,
  deps: AnalysisJobDeps = {},
): Promise<void> {
  const existing = jobs.get(scanId);
  if (existing) return existing.promise;

  const analyze = deps.analyze ?? analyzeFindings;
  const job: Job = { listeners: new Set(), promise: Promise.resolve() };
  jobs.set(scanId, job);

  job.promise = (async () => {
    updateAnalysisStatus(scanId, "running", {
      startedAt: new Date(),
      progress: null,
      error: null,
    });
    try {
      const findings = getFindingsForScan(scanId);
      const scan = getScan(scanId);
      const summary =
        (scan?.summary as FindingsSummary | null) ?? summarizeFindings(findings);

      const analysis = await analyze(findings, summary, {
        onToken: (value) => broadcast(scanId, { type: "token", value }),
        onProgress: (completed, total) => {
          updateAnalysisProgress(scanId, `${completed}/${total}`);
          broadcast(scanId, { type: "progress", completed, total });
        },
      });

      saveAnalysis(scanId, analysis, deps.model ?? getOllamaConfig().model);
      updateAnalysisStatus(scanId, "done", { finishedAt: new Date() });
      broadcast(scanId, { type: "done", analysis });
      console.log(`[analysis-job ${scanId}] done.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      updateAnalysisStatus(scanId, "error", {
        finishedAt: new Date(),
        error: message,
      });
      broadcast(scanId, { type: "error", error: message });
      console.error(`[analysis-job ${scanId}] failed:`, message);
    } finally {
      jobs.delete(scanId);
    }
  })();

  return job.promise;
}

/** Auto-start analysis after a scan completes (no-op if not eligible). */
export function ensureAnalysis(scanId: string, deps: AnalysisJobDeps = {}): void {
  if (jobs.has(scanId)) return;
  const scan = getScan(scanId);
  if (!scan || scan.status !== "done") return;
  if (scan.analysisStatus === "done") return;
  void startAnalysis(scanId, deps);
}

/** Re-run analysis for an existing completed scan (no AWS rescan). */
export function rerunAnalysis(
  scanId: string,
  deps: AnalysisJobDeps = {},
): { ok: boolean; reason?: string } {
  if (jobs.has(scanId)) return { ok: false, reason: "Analysis is already running." };
  const scan = getScan(scanId);
  if (!scan) return { ok: false, reason: "Scan not found." };
  if (scan.status !== "done") {
    return { ok: false, reason: `Scan is not complete (status: ${scan.status}).` };
  }
  void startAnalysis(scanId, deps);
  return { ok: true };
}

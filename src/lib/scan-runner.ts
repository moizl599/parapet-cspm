/**
 * Scan orchestration (SERVER-SIDE ONLY).
 *
 * Environment-driven: a scan runs under an environment (auth_mode 'base' or
 * 'role'). For 'role' envs we PRE-FLIGHT the assume-role (cheap STS call) to get
 * an actionable error instead of a long Prowler run that would just fail; then
 * Prowler itself assumes the role for the scan. Results + analysis are persisted
 * to SQLite (source of truth); the raw OCSF file stays on disk.
 *
 * Dependencies are injectable so the role / failed-assume paths can be tested
 * without Docker or a live model.
 */
import "server-only";
import { promises as fs } from "node:fs";

import { ensureAnalysis } from "@/lib/analysis-jobs";
import { normalizeFindings, summarizeFindings } from "@/lib/ocsf";
import { runProwlerScan, type ProwlerScanOptions } from "@/lib/prowler";
import { testAssumeRole, type AssumeRoleResult } from "@/lib/aws-test";
import {
  createScan,
  getEnvironment,
  getOrCreateDefaultEnvironment,
  saveFindings,
  updateScanStatus,
  type Environment,
} from "@/lib/db/repository";

export interface ScanRunnerDeps {
  runProwler?: (scanId: string, opts: ProwlerScanOptions) => Promise<string>;
  assumeRole?: (roleArn: string, externalId: string) => Promise<AssumeRoleResult>;
  readOcsf?: (path: string) => Promise<string>;
}

export interface StartedScan {
  scanId: string;
  status: "queued";
}

/** Create a queued scan under `environmentId` and run it in the background. */
export function runScanForEnvironment(
  environmentId: string,
  deps: ScanRunnerDeps = {},
): StartedScan {
  const environment = getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);

  const scan = createScan(environment.id);
  // Fire-and-forget: run the scan, then auto-start the analysis background job
  // when it completes. Both survive client disconnects (server-side tasks).
  void executeScan(scan.id, environment, deps)
    .then(() => ensureAnalysis(scan.id))
    .catch((err: unknown) => {
      console.error(`[scan ${scan.id}] unexpected orchestration error:`, err);
    });
  return { scanId: scan.id, status: "queued" };
}

/** Default-environment bridge for the no-body POST /api/scan call. */
export function startScan(environmentId?: string): StartedScan {
  const id = environmentId ?? getOrCreateDefaultEnvironment().id;
  return runScanForEnvironment(id);
}

/**
 * The scan pipeline: (preflight role) -> Prowler -> normalize -> persist
 * findings -> mark done. Analysis is NOT run here — it's a separate background
 * job auto-started by `runScanForEnvironment` once this resolves. Exported for
 * tests; `runScanForEnvironment` calls it fire-and-forget.
 */
export async function executeScan(
  scanId: string,
  environment: Environment,
  deps: ScanRunnerDeps = {},
): Promise<void> {
  const runProwler = deps.runProwler ?? runProwlerScan;
  const assumeRole = deps.assumeRole ?? testAssumeRole;
  const readOcsf = deps.readOcsf ?? ((p: string) => fs.readFile(p, "utf8"));

  try {
    updateScanStatus(scanId, "running");

    // Pre-flight assume-role for 'role' environments.
    if (environment.authMode === "role") {
      if (!environment.roleArn) {
        throw new Error("Role environment is missing a role ARN.");
      }
      const test = await assumeRole(
        environment.roleArn,
        environment.externalId ?? "",
      );
      if (!test.ok) {
        throw new Error(`Assume-role failed: ${test.error ?? "unknown error"}`);
      }
      console.log(
        `[scan ${scanId}] assume-role ok (account ${test.accountId ?? "?"}).`,
      );
    }

    const ocsfPath = await runProwler(scanId, {
      roleArn: environment.authMode === "role" ? environment.roleArn : null,
      externalId: environment.authMode === "role" ? environment.externalId : null,
      regions: environment.regions,
    });
    updateScanStatus(scanId, "running", { ocsfPath });

    const rawText = await readOcsf(ocsfPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`Prowler OCSF output at ${ocsfPath} is not valid JSON.`);
    }

    const { findings, dropped } = normalizeFindings(parsed);
    const summary = summarizeFindings(findings);
    saveFindings(scanId, findings);
    updateScanStatus(scanId, "done", { summary });
    console.log(
      `[scan ${scanId}] done: ${findings.length} findings (${dropped} dropped), ` +
        `${summary.totalFailed} failed.`,
    );
    // Analysis is decoupled: runScanForEnvironment auto-starts it as a separate
    // background job once this resolves (see ensureAnalysis).
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scan ${scanId}] failed:`, message);
    try {
      updateScanStatus(scanId, "error", { error: message });
    } catch {
      /* best-effort */
    }
  }
}

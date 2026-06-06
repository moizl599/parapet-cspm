/**
 * Typed repository layer (SERVER-SIDE ONLY) — the only place app code touches
 * the database. Drizzle's better-sqlite3 driver is synchronous, so these are
 * plain (non-async) functions.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";

import { getConnection, getDb } from "@/lib/db/client";
import {
  analyses,
  environments,
  findings,
  scans,
  type EnvironmentRow,
  type ScanRow,
} from "@/lib/db/schema";
import type { FindingStatus } from "@/lib/ocsf";
import type {
  Analysis,
  AnalysisItem,
  Finding,
  FindingsSummary,
  Severity,
} from "@/lib/severity";

export type Environment = EnvironmentRow;
export type Scan = ScanRow;

/* ------------------------------- environments ------------------------------ */

export interface CreateEnvironmentInput {
  name: string;
  targetAccountId?: string | null;
  authMode?: "role" | "base";
  roleArn?: string | null;
  externalId?: string | null;
  regions?: string[];
}

export type UpdateEnvironmentInput = Partial<
  Pick<
    Environment,
    | "name"
    | "targetAccountId"
    | "authMode"
    | "roleArn"
    | "externalId"
    | "regions"
  >
>;

export function createEnvironment(input: CreateEnvironmentInput): Environment {
  return getDb()
    .insert(environments)
    .values({
      id: randomUUID(),
      name: input.name,
      targetAccountId: input.targetAccountId ?? null,
      authMode: input.authMode ?? "base",
      roleArn: input.roleArn ?? null,
      externalId: input.externalId ?? null,
      regions: input.regions ?? [],
      createdAt: new Date(),
    })
    .returning()
    .get();
}

export function listEnvironments(): Environment[] {
  return getDb()
    .select()
    .from(environments)
    .orderBy(desc(environments.createdAt))
    .all();
}

export function getEnvironment(id: string): Environment | null {
  return (
    getDb().select().from(environments).where(eq(environments.id, id)).get() ??
    null
  );
}

export function updateEnvironment(
  id: string,
  patch: UpdateEnvironmentInput,
): Environment | null {
  if (Object.keys(patch).length === 0) return getEnvironment(id);
  return (
    getDb()
      .update(environments)
      .set(patch)
      .where(eq(environments.id, id))
      .returning()
      .get() ?? null
  );
}

export function deleteEnvironment(id: string): void {
  // FK cascade removes the environment's scans, findings, and analyses.
  getDb().delete(environments).where(eq(environments.id, id)).run();
}

const DEFAULT_ENVIRONMENT_NAME = "Default";

/** Bridge for the current single-environment flow until the UI manages them. */
export function getOrCreateDefaultEnvironment(): Environment {
  const existing = getDb()
    .select()
    .from(environments)
    .where(eq(environments.name, DEFAULT_ENVIRONMENT_NAME))
    .get();
  return existing ?? createEnvironment({ name: DEFAULT_ENVIRONMENT_NAME });
}

/* ----------------------------------- scans --------------------------------- */

export function createScan(environmentId: string): Scan {
  return getDb()
    .insert(scans)
    .values({
      id: randomUUID(),
      environmentId,
      status: "queued",
      startedAt: new Date(),
    })
    .returning()
    .get();
}

export interface ScanStatusPatch {
  error?: string;
  ocsfPath?: string;
  summary?: FindingsSummary;
}

export function updateScanStatus(
  scanId: string,
  status: ScanRow["status"],
  patch: ScanStatusPatch = {},
): Scan | null {
  const fields: Partial<ScanRow> = { status };
  if (status === "done" || status === "error") fields.finishedAt = new Date();
  if (patch.error !== undefined) fields.error = patch.error;
  if (patch.ocsfPath !== undefined) fields.ocsfPath = patch.ocsfPath;
  if (patch.summary !== undefined)
    fields.summary = patch.summary as unknown as Record<string, unknown>;

  const updated =
    getDb().update(scans).set(fields).where(eq(scans.id, scanId)).returning().get() ??
    null;

  // Stamp the environment's "last scan" once a scan completes.
  if (updated && status === "done") {
    getDb()
      .update(environments)
      .set({ lastScanId: scanId, lastScanAt: updated.finishedAt ?? new Date() })
      .where(eq(environments.id, updated.environmentId))
      .run();
  }
  return updated;
}

export function getScan(scanId: string): Scan | null {
  return getDb().select().from(scans).where(eq(scans.id, scanId)).get() ?? null;
}

export type AnalysisStatus = "pending" | "running" | "done" | "error";

export interface AnalysisStatusPatch {
  startedAt?: Date;
  finishedAt?: Date;
  progress?: string | null;
  error?: string | null;
}

export function updateAnalysisStatus(
  scanId: string,
  status: AnalysisStatus,
  patch: AnalysisStatusPatch = {},
): void {
  const fields: Partial<ScanRow> = { analysisStatus: status };
  if (patch.startedAt !== undefined) fields.analysisStartedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) fields.analysisFinishedAt = patch.finishedAt;
  if (patch.progress !== undefined) fields.analysisProgress = patch.progress;
  if (patch.error !== undefined) fields.analysisError = patch.error;
  getDb().update(scans).set(fields).where(eq(scans.id, scanId)).run();
}

export function updateAnalysisProgress(scanId: string, progress: string): void {
  getDb()
    .update(scans)
    .set({ analysisProgress: progress })
    .where(eq(scans.id, scanId))
    .run();
}

/**
 * Crash recovery: mark scans/analyses left mid-flight by a previous process as
 * errored, so nothing is stuck "running" forever. Called once on server start.
 */
export function recoverInterrupted(): { scans: number; analyses: number } {
  const now = new Date();
  const scanRes = getDb()
    .update(scans)
    .set({
      status: "error",
      error: "Interrupted by a server restart.",
      finishedAt: now,
    })
    .where(or(eq(scans.status, "queued"), eq(scans.status, "running")))
    .run();
  const analysisRes = getDb()
    .update(scans)
    .set({
      analysisStatus: "error",
      analysisError: "Analysis interrupted by a server restart — re-run to retry.",
      analysisFinishedAt: now,
    })
    .where(eq(scans.analysisStatus, "running"))
    .run();
  return {
    scans: Number(scanRes.changes),
    analyses: Number(analysisRes.changes),
  };
}

/**
 * Reconcile the denormalized scans.analysis_status with the analyses table: a
 * completed scan that already has a persisted analysis but isn't marked 'done'
 * (e.g. rows from before this column existed) is set to 'done'. Skips rows
 * currently 'running'. Idempotent; runs at startup.
 */
export function reconcileAnalysisStatus(): number {
  const res = getConnection()
    .prepare(
      `UPDATE scans SET analysis_status = 'done'
       WHERE status = 'done'
         AND analysis_status NOT IN ('done', 'running')
         AND id IN (SELECT scan_id FROM analyses)`,
    )
    .run();
  return Number(res.changes);
}

export function listScansForEnvironment(environmentId: string): Scan[] {
  return getDb()
    .select()
    .from(scans)
    .where(eq(scans.environmentId, environmentId))
    .orderBy(desc(scans.startedAt))
    .all();
}

export function getLatestScans(limit = 20): Scan[] {
  return getDb()
    .select()
    .from(scans)
    .orderBy(desc(scans.startedAt))
    .limit(limit)
    .all();
}

/**
 * Most recent COMPLETED scan for an environment that started strictly before
 * `before` — the natural "previous scan" to diff against. Null if none.
 */
export function getPreviousCompletedScan(
  environmentId: string,
  before: Date,
): Scan | null {
  return (
    getDb()
      .select()
      .from(scans)
      .where(
        and(
          eq(scans.environmentId, environmentId),
          eq(scans.status, "done"),
          lt(scans.startedAt, before),
        ),
      )
      .orderBy(desc(scans.startedAt))
      .get() ?? null
  );
}

export interface ScanHistoryItem {
  id: string;
  status: ScanRow["status"];
  analysisStatus: AnalysisStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** From the scan's analysis; null until analysis completes. */
  postureScore: number | null;
  /** Failed-finding count from the persisted summary; null if not summarized. */
  failedCount: number | null;
}

/** Per-scan history for an environment (newest first), enriched for the UI. */
export function getScanHistory(environmentId: string): ScanHistoryItem[] {
  const rows = listScansForEnvironment(environmentId);
  return rows.map((s) => ({
    id: s.id,
    status: s.status,
    analysisStatus: s.analysisStatus,
    startedAt: s.startedAt ?? null,
    finishedAt: s.finishedAt ?? null,
    postureScore: getAnalysisForScan(s.id)?.posture_score ?? null,
    failedCount:
      (s.summary as FindingsSummary | null)?.totalFailed ?? null,
  }));
}

/* --------------------------------- findings -------------------------------- */

export function saveFindings(scanId: string, items: Finding[]): void {
  if (items.length === 0) return;
  getDb()
    .insert(findings)
    .values(
      items.map((f) => ({
        scanId,
        checkId: f.checkId ?? f.id,
        title: f.checkTitle,
        service: f.service,
        severity: f.severity,
        status: f.status,
        region: f.region,
        resourceId: f.resourceId,
        resourceType: f.resourceType,
        description: f.description,
        riskDetail: f.riskDetail,
        remediationText: f.remediationText,
        remediationUrl: f.remediationUrl,
        compliance: f.complianceFrameworks,
      })),
    )
    .run();
}

/** Reconstruct normalized `Finding`s for API responses / re-analysis. Columns
 *  not persisted (riskDetail, complianceFrameworks) default to empty. */
export function getFindingsForScan(scanId: string): Finding[] {
  return getDb()
    .select()
    .from(findings)
    .where(eq(findings.scanId, scanId))
    .all()
    .map((r) => ({
      id: String(r.id),
      checkId: r.checkId ?? undefined,
      checkTitle: r.title ?? "",
      service: r.service ?? "unknown",
      severity: (r.severity ?? "informational") as Severity,
      status: (r.status ?? "manual") as FindingStatus,
      region: r.region ?? "global",
      resourceId: r.resourceId ?? "unknown",
      resourceType: r.resourceType ?? "unknown",
      description: r.description ?? "",
      riskDetail: r.riskDetail ?? "",
      remediationText: r.remediationText ?? "",
      remediationUrl: r.remediationUrl ?? null,
      complianceFrameworks: (r.compliance as string[] | null) ?? [],
    }));
}

/* --------------------------------- analyses -------------------------------- */

export function saveAnalysis(
  scanId: string,
  analysis: Analysis,
  model: string,
): void {
  getDb()
    .insert(analyses)
    .values({
      scanId,
      postureScore: analysis.posture_score,
      executiveSummary: analysis.executive_summary,
      items: analysis.items,
      quickWins: analysis.quick_wins,
      model,
      partial: analysis.partial ?? false,
      analyzedGroups: analysis.analyzedGroups ?? null,
      totalGroups: analysis.totalGroups ?? null,
      createdAt: new Date(),
    })
    .run();

  // Reflect the latest posture on the owning environment.
  const scan = getScan(scanId);
  if (scan) {
    getDb()
      .update(environments)
      .set({ lastPostureScore: analysis.posture_score })
      .where(eq(environments.id, scan.environmentId))
      .run();
  }
}

/** Latest analysis for a scan, mapped back to the `Analysis` shape. */
export function getAnalysisForScan(scanId: string): Analysis | null {
  const row = getDb()
    .select()
    .from(analyses)
    .where(eq(analyses.scanId, scanId))
    .orderBy(desc(analyses.createdAt))
    .get();
  if (!row) return null;
  const analysis: Analysis = {
    executive_summary: row.executiveSummary ?? "",
    posture_score: row.postureScore ?? 0,
    items: (row.items as AnalysisItem[] | null) ?? [],
    quick_wins: (row.quickWins as string[] | null) ?? [],
  };
  if (row.partial) {
    analysis.partial = true;
    analysis.analyzedGroups = row.analyzedGroups ?? undefined;
    analysis.totalGroups = row.totalGroups ?? undefined;
  }
  return analysis;
}

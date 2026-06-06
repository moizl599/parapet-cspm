/**
 * Drizzle schema — SQLite persistence for environments, scans, findings, and
 * analyses. This file is intentionally free of app imports and `server-only`
 * so `drizzle-kit` can read it directly during migration generation.
 *
 * JSON columns use Drizzle's `mode: "json"` (stored as TEXT, parsed on read).
 * Timestamps are epoch-ms integers exposed as `Date`.
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  targetAccountId: text("target_account_id"),
  authMode: text("auth_mode", { enum: ["role", "base"] })
    .notNull()
    .default("base"),
  roleArn: text("role_arn"),
  externalId: text("external_id"),
  /** Enabled regions; empty array = all enabled regions. */
  regions: text("regions", { mode: "json" }).$type<string[]>().notNull().default([]),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** Plain id of the most recent scan (not a FK, to avoid a circular constraint). */
  lastScanId: text("last_scan_id"),
  lastScanAt: integer("last_scan_at", { mode: "timestamp_ms" }),
  lastPostureScore: integer("last_posture_score"),
});

export const scans = sqliteTable("scans", {
  id: text("id").primaryKey(),
  environmentId: text("environment_id")
    .notNull()
    .references(() => environments.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["queued", "running", "done", "error"] }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  error: text("error"),
  /** Normalized FindingsSummary as JSON. */
  summary: text("summary", { mode: "json" }).$type<Record<string, unknown>>(),
  ocsfPath: text("ocsf_path"),
  /* Analysis lifecycle (decoupled background job; pollable + crash-safe). */
  analysisStatus: text("analysis_status", {
    enum: ["pending", "running", "done", "error"],
  })
    .notNull()
    .default("pending"),
  /** Per-chunk progress, e.g. "3/6". */
  analysisProgress: text("analysis_progress"),
  analysisStartedAt: integer("analysis_started_at", { mode: "timestamp_ms" }),
  analysisFinishedAt: integer("analysis_finished_at", { mode: "timestamp_ms" }),
  analysisError: text("analysis_error"),
});

export const findings = sqliteTable(
  "findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    checkId: text("check_id"),
    title: text("title"),
    service: text("service"),
    severity: text("severity"),
    status: text("status"),
    region: text("region"),
    resourceId: text("resource_id"),
    resourceType: text("resource_type"),
    description: text("description"),
    riskDetail: text("risk_detail"),
    remediationText: text("remediation_text"),
    remediationUrl: text("remediation_url"),
    compliance: text("compliance", { mode: "json" }).$type<string[]>(),
  },
  (t) => [
    index("findings_scan_idx").on(t.scanId),
    index("findings_lookup_idx").on(t.checkId, t.resourceId, t.region),
  ],
);

export const analyses = sqliteTable("analyses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scanId: text("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  postureScore: integer("posture_score"),
  executiveSummary: text("executive_summary"),
  items: text("items", { mode: "json" }).$type<unknown[]>(),
  quickWins: text("quick_wins", { mode: "json" }).$type<string[]>(),
  model: text("model"),
  /** True when some finding groups failed and were skipped (partial report). */
  partial: integer("partial", { mode: "boolean" }).notNull().default(false),
  /** Groups successfully analyzed / total (set when partial). */
  analyzedGroups: integer("analyzed_groups"),
  totalGroups: integer("total_groups"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export type EnvironmentRow = typeof environments.$inferSelect;
export type ScanRow = typeof scans.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type AnalysisRow = typeof analyses.$inferSelect;

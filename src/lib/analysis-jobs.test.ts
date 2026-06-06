import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// Throwaway DB before any getDb() call.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cspm-jobs-"));
process.env.DATA_DIR = tmpDir;

import { runMigrations } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import {
  createEnvironment,
  createScan,
  getAnalysisForScan,
  getEnvironment,
  getScan,
  recoverInterrupted,
  saveFindings,
  updateAnalysisStatus,
  updateScanStatus,
} from "@/lib/db/repository";
import {
  isAnalysisRunning,
  rerunAnalysis,
  startAnalysis,
  subscribeToAnalysis,
  type AnalysisJobEvent,
} from "@/lib/analysis-jobs";
import type { Analysis } from "@/lib/severity";
import type { Finding } from "@/lib/ocsf";

const tick = () => new Promise((r) => setTimeout(r, 2));

const SAMPLE_FINDINGS: Finding[] = [
  {
    id: "f-1",
    checkId: "s3_public",
    checkTitle: "Public bucket",
    service: "s3",
    severity: "critical",
    status: "fail",
    region: "us-east-1",
    resourceId: "arn:aws:s3:::demo",
    resourceType: "AwsS3Bucket",
    description: "public",
    riskDetail: "breach",
    remediationText: "block public access",
    remediationUrl: null,
    complianceFrameworks: ["CIS-2.0"],
  },
];

const REPORT: Analysis = {
  executive_summary: "One critical exposure.",
  posture_score: 55,
  items: [
    {
      title: "Lock down S3",
      severity: "critical",
      priority_rank: 1,
      affected_resources: ["arn:aws:s3:::demo"],
      why_it_matters: "x",
      attack_scenario: "y",
      remediation_steps: ["z"],
      effort: "quick-win",
      risk_of_fix: "",
      references: [],
    },
  ],
  quick_wins: ["Lock down S3"],
};

const SUMMARY = {
  totalFailed: 1,
  bySeverity: { critical: 1, high: 0, medium: 0, low: 0, informational: 0 },
  byService: { s3: 1 },
};

function makeDoneScan(name: string): { envId: string; scanId: string } {
  const env = createEnvironment({ name });
  const scan = createScan(env.id);
  saveFindings(scan.id, SAMPLE_FINDINGS);
  updateScanStatus(scan.id, "done", { summary: SUMMARY });
  return { envId: env.id, scanId: scan.id };
}

before(() => runMigrations());
after(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL handle on Windows */
  }
});

test("startAnalysis runs to completion: persists report, progress, status, posture", async () => {
  const { envId, scanId } = makeDoneScan("Happy");

  await startAnalysis(scanId, {
    model: "mock-model",
    analyze: async (_f, _s, opts) => {
      opts?.onProgress?.(0, 2);
      opts?.onToken?.("{");
      await tick();
      opts?.onProgress?.(1, 2);
      await tick();
      opts?.onProgress?.(2, 2);
      return REPORT;
    },
  });

  const scan = getScan(scanId);
  assert.equal(scan?.analysisStatus, "done");
  assert.equal(scan?.analysisProgress, "2/2");
  assert.ok(scan?.analysisStartedAt instanceof Date);
  assert.ok(scan?.analysisFinishedAt instanceof Date);
  assert.equal(isAnalysisRunning(scanId), false); // cleaned up

  const report = getAnalysisForScan(scanId);
  assert.equal(report?.posture_score, 55);
  assert.equal(getEnvironment(envId)?.lastPostureScore, 55);
});

test("background job survives a subscriber disconnect (browser closed)", async () => {
  const { scanId } = makeDoneScan("Disconnect");

  const received: AnalysisJobEvent[] = [];

  // The analyze mock yields control (await tick) so we can disconnect mid-run.
  const promise = startAnalysis(scanId, {
    model: "mock-model",
    analyze: async (_f, _s, opts) => {
      await tick(); // give the test time to subscribe
      opts?.onToken?.("first");
      await tick();
      opts?.onToken?.("second"); // emitted AFTER the subscriber disconnects
      await tick();
      opts?.onProgress?.(1, 1);
      return REPORT;
    },
  });

  // Attach a live subscriber, then disconnect after the first token.
  let unsubscribe: (() => void) | null = null;
  unsubscribe = subscribeToAnalysis(scanId, (event) => {
    received.push(event);
    if (event.type === "token") unsubscribe?.(); // "browser closes" after 1 token
  });
  assert.ok(unsubscribe, "should attach to a running job");

  // The job must finish regardless of the disconnect.
  await promise;

  // Subscriber saw only the first token, never the second or the done event.
  const tokens = received.filter((e) => e.type === "token");
  assert.equal(tokens.length, 1);
  assert.ok(!received.some((e) => e.type === "done"));

  // ...but the job ran to completion and persisted the report.
  const scan = getScan(scanId);
  assert.equal(scan?.analysisStatus, "done");
  assert.equal(getAnalysisForScan(scanId)?.posture_score, 55);
});

test("failed analysis persists error status, not a crash", async () => {
  const { scanId } = makeDoneScan("Fail");
  await startAnalysis(scanId, {
    analyze: async () => {
      throw new Error("model exploded");
    },
  });
  const scan = getScan(scanId);
  assert.equal(scan?.analysisStatus, "error");
  assert.match(scan?.analysisError ?? "", /model exploded/);
  assert.equal(getAnalysisForScan(scanId), null);
});

test("rerunAnalysis restarts analysis for an existing scan (no rescan)", async () => {
  const { scanId } = makeDoneScan("Rerun");
  // First pass fails.
  await startAnalysis(scanId, {
    analyze: async () => {
      throw new Error("first attempt failed");
    },
  });
  assert.equal(getScan(scanId)?.analysisStatus, "error");

  // Re-run succeeds without touching the scan/findings.
  const r = rerunAnalysis(scanId, {
    model: "mock-model",
    analyze: async () => REPORT,
  });
  assert.equal(r.ok, true);
  const job = subscribeToAnalysis(scanId, () => {}); // may be running
  if (job) job();
  // Wait for it to settle by polling status.
  for (let i = 0; i < 50 && getScan(scanId)?.analysisStatus !== "done"; i++) {
    await tick();
  }
  assert.equal(getScan(scanId)?.analysisStatus, "done");
  assert.equal(getAnalysisForScan(scanId)?.posture_score, 55);
});

test("crash recovery: a 'running' analysis on startup becomes error/interrupted", () => {
  // Simulate an orphaned job from a previous process.
  const { scanId } = makeDoneScan("Orphan");
  updateAnalysisStatus(scanId, "running", { startedAt: new Date() });
  // And a scan that never finished.
  const env = createEnvironment({ name: "OrphanScan" });
  const stuck = createScan(env.id);
  updateScanStatus(stuck.id, "running");

  const recovered = recoverInterrupted();
  assert.ok(recovered.analyses >= 1);
  assert.ok(recovered.scans >= 1);

  const orphanAnalysis = getScan(scanId);
  assert.equal(orphanAnalysis?.analysisStatus, "error");
  assert.match(orphanAnalysis?.analysisError ?? "", /[Ii]nterrupted/);

  const stuckScan = getScan(stuck.id);
  assert.equal(stuckScan?.status, "error");
  assert.match(stuckScan?.error ?? "", /[Ii]nterrupted/);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// Point the DB at a throwaway temp dir BEFORE any getDb() call (lazy singleton).
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cspm-db-"));
process.env.DATA_DIR = tmpDir;

import { runMigrations } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import {
  createEnvironment,
  listEnvironments,
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  getOrCreateDefaultEnvironment,
  createScan,
  updateScanStatus,
  getScan,
  listScansForEnvironment,
  getLatestScans,
  saveFindings,
  getFindingsForScan,
  saveAnalysis,
  getAnalysisForScan,
  saveGraph,
  getGraph,
  saveAttackPaths,
  getAttackPaths,
} from "@/lib/db/repository";
import type { Finding } from "@/lib/severity";
import type { GraphEdge, GraphNode } from "@/lib/graph/tagging";
import type { AttackPath } from "@/lib/graph/paths";

before(() => runMigrations());
after(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* temp dir may hold a WAL handle on Windows — OS cleans it up */
  }
});

const SAMPLE_FINDINGS: Finding[] = [
  {
    id: "f-1",
    checkId: "s3_bucket_public_access",
    checkTitle: "S3 bucket does not block public access",
    service: "s3",
    severity: "critical",
    status: "fail",
    region: "us-east-1",
    resourceId: "arn:aws:s3:::demo",
    resourceType: "AwsS3Bucket",
    description: "Public access not blocked.",
    riskDetail: "data breach",
    remediationText: "Enable Block Public Access.",
    remediationUrl: "https://docs.aws.amazon.com/s3",
    complianceFrameworks: ["CIS-2.0"],
  },
  {
    id: "f-2",
    checkId: "ec2_sg_open_22",
    checkTitle: "SSH open to the internet",
    service: "ec2",
    severity: "high",
    status: "fail",
    region: "us-east-1",
    resourceId: "sg-123",
    resourceType: "AwsEc2SecurityGroup",
    description: "Port 22 open.",
    riskDetail: "brute force",
    remediationText: "Restrict ingress.",
    remediationUrl: null,
    complianceFrameworks: [],
  },
];

const SAMPLE_ANALYSIS = {
  executive_summary: "Two exposures to fix.",
  posture_score: 61,
  items: [
    {
      title: "Lock down S3",
      severity: "critical" as const,
      priority_rank: 1,
      affected_resources: ["arn:aws:s3:::demo"],
      why_it_matters: "public data",
      attack_scenario: "anon download",
      remediation_steps: ["enable BPA"],
      effort: "quick-win" as const,
      risk_of_fix: "may break consumers",
      references: [],
    },
  ],
  quick_wins: ["Lock down S3"],
};

test("environment CRUD round-trip", () => {
  const env = createEnvironment({
    name: "Prod",
    targetAccountId: "000000000000",
    authMode: "role",
    roleArn: "arn:aws:iam::000000000000:role/ProwlerScanRole",
    externalId: "secret",
    regions: ["us-east-1", "eu-west-1"],
  });
  assert.ok(env.id);
  assert.equal(env.authMode, "role");
  assert.deepEqual(env.regions, ["us-east-1", "eu-west-1"]);
  assert.ok(env.createdAt instanceof Date);

  const fetched = getEnvironment(env.id);
  assert.equal(fetched?.name, "Prod");

  const updated = updateEnvironment(env.id, { name: "Prod-renamed", regions: [] });
  assert.equal(updated?.name, "Prod-renamed");
  assert.deepEqual(updated?.regions, []);

  assert.ok(listEnvironments().some((e) => e.id === env.id));

  deleteEnvironment(env.id);
  assert.equal(getEnvironment(env.id), null);
});

test("default environment is created once and reused", () => {
  const a = getOrCreateDefaultEnvironment();
  const b = getOrCreateDefaultEnvironment();
  assert.equal(a.id, b.id);
});

test("scan lifecycle: queued -> running -> done with summary", () => {
  const env = createEnvironment({ name: "ScanEnv" });
  const scan = createScan(env.id);
  assert.equal(scan.status, "queued");
  assert.ok(scan.startedAt instanceof Date);

  updateScanStatus(scan.id, "running", { ocsfPath: "/app/scans/x/x.ocsf.json" });
  assert.equal(getScan(scan.id)?.status, "running");
  assert.equal(getScan(scan.id)?.ocsfPath, "/app/scans/x/x.ocsf.json");

  updateScanStatus(scan.id, "done", {
    summary: { totalFailed: 2, bySeverity: { critical: 1, high: 1, medium: 0, low: 0, informational: 0 }, byService: { s3: 1, ec2: 1 } },
  });
  const done = getScan(scan.id);
  assert.equal(done?.status, "done");
  assert.ok(done?.finishedAt instanceof Date);
  assert.equal((done?.summary as { totalFailed: number }).totalFailed, 2);

  // Completing a scan stamps the environment's last scan.
  assert.equal(getEnvironment(env.id)?.lastScanId, scan.id);
  assert.ok(listScansForEnvironment(env.id).some((s) => s.id === scan.id));
  assert.ok(getLatestScans(5).some((s) => s.id === scan.id));
});

test("findings save + reconstruct round-trip", () => {
  const env = createEnvironment({ name: "FindingsEnv" });
  const scan = createScan(env.id);
  saveFindings(scan.id, SAMPLE_FINDINGS);

  const back = getFindingsForScan(scan.id);
  assert.equal(back.length, 2);
  const s3 = back.find((f) => f.service === "s3");
  assert.equal(s3?.severity, "critical");
  assert.equal(s3?.status, "fail");
  assert.equal(s3?.checkId, "s3_bucket_public_access");
  assert.equal(s3?.resourceId, "arn:aws:s3:::demo");
  // risk_detail + compliance are now persisted (Phase 8).
  assert.equal(s3?.riskDetail, "data breach");
  assert.deepEqual(s3?.complianceFrameworks, ["CIS-2.0"]);
});

test("analysis save + read, updates environment posture", () => {
  const env = createEnvironment({ name: "AnalysisEnv" });
  const scan = createScan(env.id);
  updateScanStatus(scan.id, "done", {
    summary: { totalFailed: 1, bySeverity: { critical: 1, high: 0, medium: 0, low: 0, informational: 0 }, byService: { s3: 1 } },
  });
  saveAnalysis(scan.id, SAMPLE_ANALYSIS, "llama3.1:8b");

  const analysis = getAnalysisForScan(scan.id);
  assert.equal(analysis?.posture_score, 61);
  assert.equal(analysis?.items.length, 1);
  assert.equal(analysis?.items[0].title, "Lock down S3");
  assert.equal(getEnvironment(env.id)?.lastPostureScore, 61);
  // A full (non-partial) report does not carry partial metadata.
  assert.equal(analysis?.partial, undefined);
});

test("partial analysis round-trips its partial metadata", () => {
  const env = createEnvironment({ name: "PartialEnv" });
  const scan = createScan(env.id);
  updateScanStatus(scan.id, "done", {});
  saveAnalysis(
    scan.id,
    { ...SAMPLE_ANALYSIS, partial: true, analyzedGroups: 5, totalGroups: 6 },
    "llama3.1:8b",
  );

  const analysis = getAnalysisForScan(scan.id);
  assert.equal(analysis?.partial, true);
  assert.equal(analysis?.analyzedGroups, 5);
  assert.equal(analysis?.totalGroups, 6);
});

const SAMPLE_NODES: GraphNode[] = [
  {
    nodeKey: "s3_bucket:arn:aws:s3:::demo",
    type: "s3_bucket",
    name: "demo",
    region: "us-east-1",
    accountId: "111122223333",
    capabilities: ["publicly_accessible", "holds_data"],
    source: "prowler",
  },
  {
    nodeKey: "iam_role:arn:aws:iam::111122223333:role/app",
    type: "iam_role",
    name: "app",
    region: "us-east-1",
    accountId: "111122223333",
    capabilities: [],
    source: "prowler",
  },
];
const SAMPLE_EDGES: GraphEdge[] = [
  {
    srcKey: "ec2_instance:i-1",
    dstKey: "iam_role:arn:aws:iam::111122223333:role/app",
    relation: "uses_role",
    evidence: { checkId: "ec2_instance_imdsv2_enabled", title: "IMDSv2" },
    source: "prowler",
  },
];

test("graph save + read round-trips nodes, capabilities, and edges", () => {
  const env = createEnvironment({ name: "GraphEnv" });
  const scan = createScan(env.id);
  saveGraph(scan.id, SAMPLE_NODES, SAMPLE_EDGES);

  const graph = getGraph(scan.id);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  const bucket = graph.nodes.find((n) => n.nodeKey.includes("demo"));
  assert.deepEqual(bucket?.capabilities, ["publicly_accessible", "holds_data"]);
  assert.equal(graph.edges[0].relation, "uses_role");
  assert.equal(graph.edges[0].evidence?.checkId, "ec2_instance_imdsv2_enabled");

  // Idempotent: saving again replaces rather than appends.
  saveGraph(scan.id, SAMPLE_NODES, SAMPLE_EDGES);
  const again = getGraph(scan.id);
  assert.equal(again.nodes.length, 2);
  assert.equal(again.edges.length, 1);
});

const SAMPLE_PATHS: AttackPath[] = [
  {
    ruleId: "public-data-exposure",
    title: "Public data store: demo",
    severity: "critical",
    entryKey: "s3_bucket:arn:aws:s3:::demo",
    targetKey: "s3_bucket:arn:aws:s3:::demo",
    hops: { nodes: ["s3_bucket:arn:aws:s3:::demo"], edges: [] },
    capabilities: ["publicly_accessible", "holds_data"],
    confidence: "medium",
  },
];

test("attack paths save + read; narrative left null for AP-3", () => {
  const env = createEnvironment({ name: "PathsEnv" });
  const scan = createScan(env.id);
  saveAttackPaths(scan.id, SAMPLE_PATHS);

  const rows = getAttackPaths(scan.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ruleId, "public-data-exposure");
  assert.equal(rows[0].severity, "critical");
  assert.equal(rows[0].confidence, "medium");
  assert.equal(rows[0].narrative, null);

  // Idempotent: re-saving replaces rather than appends.
  saveAttackPaths(scan.id, SAMPLE_PATHS);
  assert.equal(getAttackPaths(scan.id).length, 1);
});

test("deleting an environment cascades to scans, findings, analyses, graph, paths", () => {
  const env = createEnvironment({ name: "Cascade" });
  const scan = createScan(env.id);
  saveFindings(scan.id, SAMPLE_FINDINGS);
  saveAnalysis(scan.id, SAMPLE_ANALYSIS, "llama3.1:8b");
  saveGraph(scan.id, SAMPLE_NODES, SAMPLE_EDGES);
  saveAttackPaths(scan.id, SAMPLE_PATHS);

  deleteEnvironment(env.id);

  assert.equal(getScan(scan.id), null);
  assert.equal(getFindingsForScan(scan.id).length, 0);
  assert.equal(getAnalysisForScan(scan.id), null);
  assert.equal(getGraph(scan.id).nodes.length, 0);
  assert.equal(getGraph(scan.id).edges.length, 0);
  assert.equal(getAttackPaths(scan.id).length, 0);
});

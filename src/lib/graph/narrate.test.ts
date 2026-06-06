import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// Point the DB at a throwaway temp dir BEFORE any getDb() call.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cspm-narrate-"));
process.env.DATA_DIR = tmpDir;

import { runMigrations } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import {
  createEnvironment,
  createScan,
  saveFindings,
  saveGraph,
  saveAttackPaths,
  getAttackPaths,
} from "@/lib/db/repository";
import { narrateAttackPaths } from "./narrate.ts";
import type { GraphNode } from "./tagging.ts";
import type { AttackPath } from "./paths.ts";
import type { Finding } from "@/lib/ocsf";
import type { StreamChatFn } from "@/lib/analyze";

before(() => runMigrations());
after(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL handle on Windows — OS cleans up */
  }
});

const BUCKET_ID = "arn:aws:s3:::acme-public";
const ROLE_ID = "arn:aws:iam::111122223333:role/admin";
const BUCKET_KEY = `s3_bucket:${BUCKET_ID}`;
const ROLE_KEY = `iam_role:${ROLE_ID}`;

const NODES: GraphNode[] = [
  {
    nodeKey: BUCKET_KEY,
    type: "s3_bucket",
    name: "acme-public",
    region: "us-east-1",
    accountId: "111122223333",
    capabilities: ["publicly_accessible", "holds_data"],
    source: "prowler",
  },
  {
    nodeKey: ROLE_KEY,
    type: "iam_role",
    name: "admin",
    region: "us-east-1",
    accountId: "111122223333",
    capabilities: ["privileged"],
    source: "prowler",
  },
];

function finding(checkId: string, resourceId: string, title: string): Finding {
  return {
    id: `${checkId}:${resourceId}`,
    checkId,
    checkTitle: title,
    service: checkId.split("_")[0],
    severity: "critical",
    status: "fail",
    region: "us-east-1",
    resourceId,
    resourceType: "Aws",
    description: "",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: [],
  };
}

const PATHS: AttackPath[] = [
  {
    ruleId: "public-data-exposure",
    title: "Public data store: acme-public",
    severity: "critical",
    entryKey: BUCKET_KEY,
    targetKey: BUCKET_KEY,
    hops: { nodes: [BUCKET_KEY], edges: [] },
    capabilities: ["publicly_accessible", "holds_data"],
    confidence: "medium",
  },
  {
    ruleId: "privilege-escalation-identity",
    title: "Identity can escalate to admin: admin",
    severity: "high",
    entryKey: ROLE_KEY,
    targetKey: ROLE_KEY,
    hops: { nodes: [ROLE_KEY], edges: [] },
    capabilities: ["privileged"],
    confidence: "medium",
  },
];

const VALID_NARRATIVE = JSON.stringify({
  summary: "A public S3 bucket exposes a potential data store to the internet.",
  attack_scenario: "An attacker lists and downloads objects from the bucket.",
  blast_radius: "Everything stored in the bucket.",
  severity_rationale: "Internet-readable data store; no auth required.",
  break_the_chain: [
    {
      link: "the bucket's public access",
      action: "Enable S3 Block Public Access: aws s3api put-public-access-block ...",
      effort: "quick-win",
    },
  ],
  confidence_note: "holds_data is inferred from resource type; data sensitivity is unconfirmed.",
  false_positive_risk: "medium",
});

function seedScan(): string {
  const env = createEnvironment({ name: "NarrateEnv" });
  const scan = createScan(env.id);
  saveFindings(scan.id, [
    finding("s3_bucket_public_access", BUCKET_ID, "S3 bucket allows public access"),
    finding("iam_role_administrator_access", ROLE_ID, "Role has administrator access"),
  ]);
  saveGraph(scan.id, NODES, []);
  saveAttackPaths(scan.id, PATHS);
  return scan.id;
}

/** A streamer that yields a per-call response decided by `respond(userText)`. */
function mockStreamer(respond: (userText: string) => string): StreamChatFn {
  return (messages) => {
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    const text = respond(userText);
    return (async function* () {
      yield text.slice(0, Math.floor(text.length / 2));
      yield text.slice(Math.floor(text.length / 2));
    })();
  };
}

test("valid model output is persisted as the path narrative", async () => {
  const scanId = seedScan();
  const result = await narrateAttackPaths(
    scanId,
    {},
    { streamChat: mockStreamer(() => VALID_NARRATIVE) },
  );

  assert.equal(result.total, 2);
  assert.equal(result.narrated, 2);

  const rows = getAttackPaths(scanId);
  const bucketPath = rows.find((r) => r.ruleId === "public-data-exposure");
  assert.ok(bucketPath?.narrative, "bucket path should have a narrative");
  const narrative = bucketPath.narrative as { summary: string; false_positive_risk: string };
  assert.match(narrative.summary, /public S3 bucket/i);
  assert.equal(narrative.false_positive_risk, "medium");
});

test("a broken model response leaves THAT path's narrative null, without failing the others", async () => {
  const scanId = seedScan();

  // Valid for the bucket path, junk for the role path (both attempts).
  const streamChat = mockStreamer((userText) =>
    userText.includes("acme-public") ? VALID_NARRATIVE : "sorry, here is not json",
  );

  const result = await narrateAttackPaths(scanId, {}, { streamChat });
  assert.equal(result.total, 2);
  assert.equal(result.narrated, 1); // only the bucket path narrated

  const rows = getAttackPaths(scanId);
  const bucketPath = rows.find((r) => r.ruleId === "public-data-exposure");
  const rolePath = rows.find((r) => r.ruleId === "privilege-escalation-identity");
  assert.ok(bucketPath?.narrative, "bucket path narrated");
  assert.equal(rolePath?.narrative, null, "role path keeps a null narrative");
});

test("falls back to json_object on a first-attempt failure (single retry)", async () => {
  const scanId = seedScan();
  const calls: string[] = [];
  // First call per path -> junk; second (fallback) -> valid.
  const streamChat: StreamChatFn = (messages) => {
    const fmt = (messages.length > 2 ? "retry" : "first"); // retry adds a 3rd msg
    calls.push(fmt);
    const text = fmt === "retry" ? VALID_NARRATIVE : "not json";
    return (async function* () {
      yield text;
    })();
  };

  const result = await narrateAttackPaths(scanId, {}, { streamChat });
  assert.equal(result.narrated, 2);
  // Each path used 2 calls (first fail + fallback success).
  assert.equal(calls.filter((c) => c === "first").length, 2);
  assert.equal(calls.filter((c) => c === "retry").length, 2);
});

test("only critical/high paths are selected; lower-severity paths stay un-narrated", async () => {
  const env = createEnvironment({ name: "SelEnv" });
  const scan = createScan(env.id);
  saveGraph(scan.id, NODES, []);
  saveAttackPaths(scan.id, [
    PATHS[0], // critical -> narrated
    {
      ruleId: "public-compute-unencrypted",
      title: "medium thing",
      severity: "medium",
      entryKey: BUCKET_KEY,
      targetKey: BUCKET_KEY,
      hops: { nodes: [BUCKET_KEY], edges: [] },
      capabilities: ["unencrypted"],
      confidence: "medium",
    },
  ]);

  const result = await narrateAttackPaths(
    scan.id,
    {},
    { streamChat: mockStreamer(() => VALID_NARRATIVE) },
  );
  assert.equal(result.total, 1); // only the critical path eligible

  const rows = getAttackPaths(scan.id);
  const medium = rows.find((r) => r.severity === "medium");
  assert.equal(medium?.narrative, null);
});

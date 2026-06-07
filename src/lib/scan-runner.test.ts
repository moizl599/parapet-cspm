import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";

// Throwaway DB before any getDb() call.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "cspm-runner-"));
process.env.DATA_DIR = tmpDir;

import { runMigrations } from "@/lib/db/migrate";
import { closeDb } from "@/lib/db/client";
import {
  createEnvironment,
  createScan,
  getScan,
  getFindingsForScan,
  getGraph,
  getAttackPaths,
} from "@/lib/db/repository";
import { executeScan, type ScanRunnerDeps } from "@/lib/scan-runner";
import type { ProwlerScanOptions } from "@/lib/prowler";
import type { ParsedGraph } from "@/lib/graph/pmapper-parse";

const fixtureUrl = new URL("./__fixtures__/sample.ocsf.json", import.meta.url);
const fixtureText = readFileSync(fixtureUrl, "utf8");
const ROLE_ARN = "arn:aws:iam::946445279593:role/cspm-scan-role";

before(() => runMigrations());
after(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL handle on Windows — OS cleans up */
  }
});

// Note: analysis is now a decoupled background job (see analysis-jobs.test.ts);
// executeScan only runs the scan and persists findings.

test("role scan: preflight assume-role, role+region flags, persists findings", async () => {
  const env = createEnvironment({
    name: "RoleEnv",
    authMode: "role",
    roleArn: ROLE_ARN,
    externalId: "ext-abc",
    regions: ["us-east-2"],
  });
  const scan = createScan(env.id);

  const captured: { arn: string; ext: string; opts: ProwlerScanOptions | null } = {
    arn: "",
    ext: "",
    opts: null,
  };

  const deps: ScanRunnerDeps = {
    assumeRole: async (arn, ext) => {
      captured.arn = arn;
      captured.ext = ext;
      return { ok: true, accountId: "946445279593" };
    },
    runProwler: async (_id, opts) => {
      captured.opts = opts;
      return "/tmp/fake.ocsf.json";
    },
    readOcsf: async () => fixtureText,
  };

  await executeScan(scan.id, env, deps);

  // Preflight assume-role received the env's role + external id.
  assert.equal(captured.arn, ROLE_ARN);
  assert.equal(captured.ext, "ext-abc");
  // Prowler invoked with role + region flags.
  assert.equal(captured.opts?.roleArn, ROLE_ARN);
  assert.equal(captured.opts?.externalId, "ext-abc");
  assert.deepEqual(captured.opts?.regions, ["us-east-2"]);

  // Scan completed and findings persisted (incl. compliance from the fixture).
  const done = getScan(scan.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.analysisStatus, "pending"); // analysis not started by executeScan
  const findings = getFindingsForScan(scan.id);
  assert.equal(findings.length, 3);
  assert.ok(
    findings.some((f) => f.complianceFrameworks.length > 0),
    "compliance frameworks persisted",
  );
});

test("failed assume-role lands as scan error and skips Prowler", async () => {
  const env = createEnvironment({
    name: "RoleFail",
    authMode: "role",
    roleArn: ROLE_ARN,
    externalId: "wrong-id",
  });
  const scan = createScan(env.id);

  let prowlerCalled = false;
  await executeScan(scan.id, env, {
    assumeRole: async () => ({
      ok: false,
      error:
        "Access denied assuming the role. Verify the role's trust policy and external ID.",
    }),
    runProwler: async () => {
      prowlerCalled = true;
      return "/tmp/never.ocsf.json";
    },
  });

  const s = getScan(scan.id);
  assert.equal(s?.status, "error");
  assert.match(s?.error ?? "", /Assume-role failed/);
  assert.match(s?.error ?? "", /Access denied/);
  assert.equal(prowlerCalled, false, "Prowler must not run when assume-role fails");
  assert.equal(getFindingsForScan(scan.id).length, 0);
});

test("base environment: no assume-role, Prowler gets null role", async () => {
  const env = createEnvironment({ name: "BaseEnv" }); // authMode defaults to 'base'
  const scan = createScan(env.id);

  const flags: { assumeCalled: boolean; opts: ProwlerScanOptions | null } = {
    assumeCalled: false,
    opts: null,
  };
  await executeScan(scan.id, env, {
    assumeRole: async () => {
      flags.assumeCalled = true;
      return { ok: true };
    },
    runProwler: async (_id, opts) => {
      flags.opts = opts;
      return "/tmp/base.ocsf.json";
    },
    readOcsf: async () => fixtureText,
  });

  assert.equal(flags.assumeCalled, false, "base mode must not assume a role");
  assert.equal(flags.opts?.roleArn, null);
  assert.equal(getScan(scan.id)?.status, "done");
});

/* ----------------------------- AP-5: PMapper gate ------------------------- */

const ADMIN_ARN = "arn:aws:iam::946445279593:role/parapet-mh-admin-role";
const USER_ARN = "arn:aws:iam::946445279593:user/cspm-test-user";

function fakePmapperGraph(): ParsedGraph {
  return {
    nodes: [
      {
        nodeKey: `iam_user:${USER_ARN}`,
        type: "iam_user",
        name: "cspm-test-user",
        region: null,
        accountId: "946445279593",
        capabilities: [],
        source: "pmapper",
      },
      {
        nodeKey: `iam_role:${ADMIN_ARN}`,
        type: "iam_role",
        name: "parapet-mh-admin-role",
        region: null,
        accountId: "946445279593",
        capabilities: ["privileged"],
        source: "pmapper",
      },
    ],
    edges: [
      {
        srcKey: `iam_user:${USER_ARN}`,
        dstKey: `iam_role:${ADMIN_ARN}`,
        relation: "can_assume",
        evidence: { reason: "can access via sts:AssumeRole" },
        source: "pmapper",
      },
    ],
  };
}

test("PMAPPER_ENABLED off (default): PMapper is not invoked and the graph is v1 (Prowler-only)", async () => {
  delete process.env.PMAPPER_ENABLED;
  const env = createEnvironment({ name: "PmOff" });
  const scan = createScan(env.id);

  let pmapperCalled = false;
  await executeScan(scan.id, env, {
    runProwler: async () => "/tmp/off.ocsf.json",
    readOcsf: async () => fixtureText,
    runPmapper: async () => {
      pmapperCalled = true;
      return fakePmapperGraph();
    },
  });

  assert.equal(pmapperCalled, false, "PMapper must not run when disabled");
  const graph = getGraph(scan.id);
  // Fixture has no IAM identity edges -> 0 edges, no escalation chain.
  assert.equal(graph.edges.length, 0);
  assert.equal(
    getAttackPaths(scan.id).some((p) => p.ruleId === "privilege-escalation-chain"),
    false,
  );
});

test("PMAPPER_ENABLED on: PMapper edges merge and an identity escalation chain is persisted", async () => {
  process.env.PMAPPER_ENABLED = "true";
  try {
    const env = createEnvironment({ name: "PmOn" });
    const scan = createScan(env.id);

    let pmapperCalled = false;
    await executeScan(scan.id, env, {
      runProwler: async () => "/tmp/on.ocsf.json",
      readOcsf: async () => fixtureText,
      runPmapper: async () => {
        pmapperCalled = true;
        return fakePmapperGraph();
      },
    });

    assert.equal(pmapperCalled, true, "PMapper runs when enabled");
    const graph = getGraph(scan.id);
    // The PMapper can_assume edge merged into the persisted graph.
    assert.ok(
      graph.edges.some((e) => e.relation === "can_assume" && e.source === "pmapper"),
      "merged graph should contain the PMapper can_assume edge",
    );
    // The path engine found the real identity multi-hop chain.
    const chain = getAttackPaths(scan.id).find(
      (p) => p.ruleId === "privilege-escalation-chain",
    );
    assert.ok(chain, "expected a privilege-escalation-chain path");
    assert.equal(chain.confidence, "high");
    assert.equal(chain.entryKey, `iam_user:${USER_ARN}`);
    assert.equal(chain.targetKey, `iam_role:${ADMIN_ARN}`);
  } finally {
    delete process.env.PMAPPER_ENABLED;
  }
});

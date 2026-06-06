import { test } from "node:test";
import assert from "node:assert/strict";

import { diffScans, findingKey, type ScanSnapshot } from "./diff.ts";
import type { Finding, Severity } from "./severity.ts";

/** Minimal Finding factory — only the fields diffing reads matter. */
function mk(
  partial: Partial<Finding> & {
    checkId: string;
    resourceId: string;
    region: string;
  },
): Finding {
  return {
    id: `${partial.checkId}:${partial.resourceId}:${partial.region}`,
    checkTitle: partial.checkTitle ?? partial.checkId,
    service: partial.service ?? "ec2",
    severity: (partial.severity ?? "medium") as Severity,
    status: partial.status ?? "fail",
    description: "",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: [],
    resourceType: partial.resourceType ?? "resource",
    ...partial,
  };
}

function snapshot(
  scanId: string,
  findings: Finding[],
  postureScore: number | null,
): ScanSnapshot {
  return { scanId, findings, postureScore };
}

test("findingKey is stable on (checkId, resourceId, region)", () => {
  const a = mk({ checkId: "s3_public", resourceId: "bucket-1", region: "us-east-1" });
  const b = mk({
    checkId: "s3_public",
    resourceId: "bucket-1",
    region: "us-east-1",
    severity: "critical", // severity/status don't affect identity
    status: "pass",
  });
  assert.equal(findingKey(a), findingKey(b));
});

test("introduced / resolved / unchanged are classified correctly", () => {
  // OLDER scan: two failing issues.
  const stillOpen = mk({
    checkId: "ec2_sg_open",
    resourceId: "sg-1",
    region: "us-east-1",
    severity: "high",
  });
  const willResolve = mk({
    checkId: "iam_mfa",
    resourceId: "user-1",
    region: "global",
    severity: "medium",
  });
  const before = snapshot("scan-old", [stillOpen, willResolve], 47);

  // NEWER scan: the still-open one persists, a brand-new one appears, and the
  // resolved one is now passing (present but status=pass) — must NOT count as open.
  const stillOpenAgain = mk({
    checkId: "ec2_sg_open",
    resourceId: "sg-1",
    region: "us-east-1",
    severity: "high",
  });
  const newIssue = mk({
    checkId: "s3_public",
    resourceId: "bucket-9",
    region: "eu-west-1",
    severity: "critical",
  });
  const nowPassing = mk({
    checkId: "iam_mfa",
    resourceId: "user-1",
    region: "global",
    severity: "medium",
    status: "pass",
  });
  const after = snapshot("scan-new", [stillOpenAgain, newIssue, nowPassing], 58);

  const diff = diffScans(before, after);

  assert.deepEqual(
    diff.introduced.map((f) => f.checkId),
    ["s3_public"],
  );
  assert.deepEqual(
    diff.resolved.map((f) => f.checkId),
    ["iam_mfa"],
  );
  assert.deepEqual(
    diff.unchanged.map((f) => f.checkId),
    ["ec2_sg_open"],
  );
});

test("resolved also covers findings that disappear entirely", () => {
  const before = snapshot(
    "old",
    [mk({ checkId: "rds_public", resourceId: "db-1", region: "us-east-1" })],
    40,
  );
  const after = snapshot("new", [], 100);
  const diff = diffScans(before, after);
  assert.equal(diff.introduced.length, 0);
  assert.equal(diff.unchanged.length, 0);
  assert.deepEqual(
    diff.resolved.map((f) => f.checkId),
    ["rds_public"],
  );
});

test("only FAILED findings drive the diff (pass→fail is introduced)", () => {
  const before = snapshot(
    "old",
    [
      mk({
        checkId: "kms_rotation",
        resourceId: "key-1",
        region: "us-east-1",
        status: "pass",
      }),
    ],
    90,
  );
  const after = snapshot(
    "new",
    [
      mk({
        checkId: "kms_rotation",
        resourceId: "key-1",
        region: "us-east-1",
        status: "fail",
      }),
    ],
    80,
  );
  const diff = diffScans(before, after);
  assert.deepEqual(
    diff.introduced.map((f) => f.checkId),
    ["kms_rotation"],
  );
  assert.equal(diff.resolved.length, 0);
});

test("introduced findings are sorted by severity (most severe first)", () => {
  const before = snapshot("old", [], 100);
  const after = snapshot(
    "new",
    [
      mk({ checkId: "a_low", resourceId: "r1", region: "us-east-1", severity: "low" }),
      mk({
        checkId: "b_crit",
        resourceId: "r2",
        region: "us-east-1",
        severity: "critical",
      }),
      mk({
        checkId: "c_med",
        resourceId: "r3",
        region: "us-east-1",
        severity: "medium",
      }),
    ],
    20,
  );
  const diff = diffScans(before, after);
  assert.deepEqual(
    diff.introduced.map((f) => f.severity),
    ["critical", "medium", "low"],
  );
});

test("posture delta is computed and null-safe", () => {
  const withScores = diffScans(
    snapshot("old", [], 47),
    snapshot("new", [], 58),
  );
  assert.deepEqual(withScores.postureDelta, { before: 47, after: 58, delta: 11 });

  const missing = diffScans(snapshot("old", [], null), snapshot("new", [], 58));
  assert.deepEqual(missing.postureDelta, { before: null, after: 58, delta: null });
});

test("summary delta reports per-severity change", () => {
  const before = snapshot(
    "old",
    [mk({ checkId: "x", resourceId: "r1", region: "us-east-1", severity: "high" })],
    50,
  );
  const after = snapshot(
    "new",
    [
      mk({ checkId: "x", resourceId: "r1", region: "us-east-1", severity: "high" }),
      mk({
        checkId: "y",
        resourceId: "r2",
        region: "us-east-1",
        severity: "critical",
      }),
    ],
    40,
  );
  const diff = diffScans(before, after);
  assert.equal(diff.summaryDelta.totalFailedDelta, 1);
  assert.equal(diff.summaryDelta.bySeverityDelta.critical, 1);
  assert.equal(diff.summaryDelta.bySeverityDelta.high, 0);
});

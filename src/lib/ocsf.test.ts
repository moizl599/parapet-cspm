import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  normalizeFinding,
  normalizeFindings,
  summarizeFindings,
  type Finding,
} from "./ocsf.ts";

const fixtureUrl = new URL("./__fixtures__/sample.ocsf.json", import.meta.url);
const rawOcsf: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

function byId(findings: Finding[], idFragment: string): Finding {
  const found = findings.find((f) => f.id.includes(idFragment));
  assert.ok(found, `expected a finding whose id contains "${idFragment}"`);
  return found;
}

test("drops malformed entries without throwing, keeps the valid ones", () => {
  const { findings, dropped } = normalizeFindings(rawOcsf);
  // Fixture has 3 valid findings + 1 missing-uid + 1 null = 2 dropped.
  assert.equal(findings.length, 3);
  assert.equal(dropped, 2);
});

test("normalizes a full FAIL finding with all fields present", () => {
  const { findings } = normalizeFindings(rawOcsf);
  const sg = byId(findings, "ec2_securitygroup_allow_ingress");

  assert.equal(sg.checkTitle.startsWith("Ensure no security groups"), true);
  assert.equal(sg.service, "ec2");
  assert.equal(sg.severity, "high");
  assert.equal(sg.status, "fail");
  assert.equal(sg.region, "us-east-1");
  assert.equal(
    sg.resourceId,
    "arn:aws:ec2:us-east-1:000000000000:security-group/sg-REDACTED",
  );
  assert.equal(sg.resourceType, "AwsEc2SecurityGroup");
  assert.equal(sg.description.startsWith("Ensure no security groups"), true);
  assert.equal(sg.riskDetail.length > 0, true);
  assert.equal(sg.remediationText.startsWith("Remove the 0.0.0.0/0"), true);
  assert.equal(
    sg.remediationUrl,
    "https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html",
  );
  assert.deepEqual(sg.complianceFrameworks, [
    "CIS-2.0",
    "AWS-Foundational-Security-Best-Practices",
  ]);
});

test("maps PASS status and an empty references list to a null URL", () => {
  const { findings } = normalizeFindings(rawOcsf);
  const iam = byId(findings, "iam_password_policy");

  assert.equal(iam.status, "pass");
  assert.equal(iam.severity, "low");
  assert.equal(iam.service, "iam");
  assert.equal(iam.remediationUrl, null);
  assert.deepEqual(iam.complianceFrameworks, []);
});

test("derives severity from severity_id, service from check id, and skips non-URL references", () => {
  const { findings } = normalizeFindings(rawOcsf);
  const s3 = byId(findings, "s3_bucket_public_access");

  // No `severity` name present -> derived from severity_id 5.
  assert.equal(s3.severity, "critical");
  // No group.name -> derived from the check id prefix.
  assert.equal(s3.service, "s3");
  // No cloud.region and no resource.region -> falls back to "global".
  assert.equal(s3.region, "global");
  // First reference "not-a-url" is skipped; the https one is chosen.
  assert.equal(
    s3.remediationUrl,
    "https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html",
  );
  // Compliance read from the top-level field when `unmapped` is absent.
  assert.deepEqual(s3.complianceFrameworks, ["CIS-2.0"]);
});

test("summary counts FAILED findings only, by severity and service", () => {
  const { findings } = normalizeFindings(rawOcsf);
  const summary = summarizeFindings(findings);

  // 2 failed (ec2 high, s3 critical); the iam PASS is excluded.
  assert.equal(summary.totalFailed, 2);
  assert.equal(summary.bySeverity.high, 1);
  assert.equal(summary.bySeverity.critical, 1);
  assert.equal(summary.bySeverity.low, 0);
  assert.deepEqual(summary.byService, { ec2: 1, s3: 1 });
});

test("never throws on junk input", () => {
  assert.equal(normalizeFinding(null), null);
  assert.equal(normalizeFinding(42), null);
  assert.equal(normalizeFinding({}), null); // missing uid
  assert.deepEqual(normalizeFindings("not an array"), { findings: [], dropped: 0 });
  assert.deepEqual(normalizeFindings(undefined), { findings: [], dropped: 0 });
});

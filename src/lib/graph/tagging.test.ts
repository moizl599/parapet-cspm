import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGraph, type GraphNode } from "./tagging.ts";
import type { Finding, RelatedResource } from "../ocsf.ts";

const ACCOUNT = "111122223333";

function mk(
  partial: Partial<Finding> & {
    checkId: string;
    resourceType: string;
    resourceId: string;
  },
): Finding {
  return {
    id: partial.id ?? `${partial.checkId}:${partial.resourceId}`,
    checkTitle: partial.checkTitle ?? partial.checkId,
    service: partial.service ?? partial.checkId.split("_")[0],
    severity: partial.severity ?? "high",
    status: partial.status ?? "fail",
    region: partial.region ?? "us-east-1",
    description: "",
    riskDetail: "",
    remediationText: "",
    remediationUrl: null,
    complianceFrameworks: [],
    accountId: partial.accountId ?? ACCOUNT,
    ...partial,
  };
}

/** The kinds of findings in the sandbox, plus an EC2 instance that carries
 *  related resources (role + 2 SGs) so edge derivation is exercised. */
function sandboxFindings(): Finding[] {
  return [
    mk({
      checkId: "s3_bucket_public_access",
      resourceType: "AwsS3Bucket",
      resourceId: "arn:aws:s3:::acme-public",
      severity: "critical",
    }),
    // Second failing finding on the SAME bucket -> capabilities must merge.
    mk({
      checkId: "s3_bucket_default_encryption",
      resourceType: "AwsS3Bucket",
      resourceId: "arn:aws:s3:::acme-public",
    }),
    mk({
      checkId: "ec2_securitygroup_allow_ingress_from_internet_to_port_22",
      resourceType: "AwsEc2SecurityGroup",
      resourceId: "arn:aws:ec2:us-east-1:111122223333:security-group/sg-open",
    }),
    mk({
      checkId: "rds_instance_no_public_access",
      resourceType: "AwsRdsDbInstance",
      resourceId: "arn:aws:rds:us-east-1:111122223333:db:prod-db",
    }),
    mk({
      checkId: "iam_user_mfa_enabled_console_access",
      resourceType: "AwsIamUser",
      resourceId: "arn:aws:iam::111122223333:user/alice",
    }),
    mk({
      checkId: "ec2_ebs_volume_encryption",
      resourceType: "AwsEc2Volume",
      resourceId: "vol-0abc123",
    }),
    mk({
      checkId: "ec2_instance_imdsv2_enabled",
      resourceType: "AwsEc2Instance",
      resourceId: "arn:aws:ec2:us-east-1:111122223333:instance/i-0xyz",
      relatedResources: [
        { type: "AwsIamRole", id: "arn:aws:iam::111122223333:role/app-role" },
        {
          type: "AwsEc2SecurityGroup",
          id: "arn:aws:ec2:us-east-1:111122223333:security-group/sg-aaa",
        },
        {
          type: "AwsEc2SecurityGroup",
          id: "arn:aws:ec2:us-east-1:111122223333:security-group/sg-bbb",
        },
      ] satisfies RelatedResource[],
    }),
  ];
}

function nodeByKeyPart(nodes: GraphNode[], part: string): GraphNode {
  const found = nodes.find((n) => n.nodeKey.includes(part));
  assert.ok(found, `expected a node whose key contains "${part}"`);
  return found;
}

test("builds one node per distinct resource (incl. related endpoints)", () => {
  const { nodes } = buildGraph(sandboxFindings());
  // 6 primary resources + 3 related endpoints (role, sg-aaa, sg-bbb).
  // The two S3 findings collapse to ONE bucket node.
  assert.equal(nodes.length, 9);
  // Carries the per-resource descriptive fields.
  const bucket = nodeByKeyPart(nodes, "acme-public");
  assert.equal(bucket.type, "s3_bucket");
  assert.equal(bucket.name, "acme-public");
  assert.equal(bucket.region, "us-east-1");
  assert.equal(bucket.accountId, ACCOUNT);
  assert.equal(bucket.source, "prowler");
});

test("capability tagging matches the design mapping (and merges per resource)", () => {
  const { nodes } = buildGraph(sandboxFindings());

  // public S3 bucket: publicly_accessible (check) + holds_data (type) +
  // unencrypted (second finding) -> merged & ordered.
  assert.deepEqual(nodeByKeyPart(nodes, "acme-public").capabilities, [
    "publicly_accessible",
    "holds_data",
    "unencrypted",
  ]);

  // open security group -> exposed_internet
  assert.deepEqual(nodeByKeyPart(nodes, "sg-open").capabilities, [
    "exposed_internet",
  ]);

  // public RDS -> publicly_accessible + holds_data
  assert.deepEqual(nodeByKeyPart(nodes, "prod-db").capabilities, [
    "publicly_accessible",
    "holds_data",
  ]);

  // IAM user without MFA -> weak_auth
  assert.deepEqual(nodeByKeyPart(nodes, "user/alice").capabilities, [
    "weak_auth",
  ]);

  // unencrypted EBS -> unencrypted
  assert.deepEqual(nodeByKeyPart(nodes, "vol-0abc123").capabilities, [
    "unencrypted",
  ]);

  // EC2 instance (imdsv2 check maps to no capability) -> no tags
  assert.deepEqual(nodeByKeyPart(nodes, "instance/i-0xyz").capabilities, []);
  // related endpoints carry no capabilities of their own
  assert.deepEqual(nodeByKeyPart(nodes, "role/app-role").capabilities, []);
  assert.deepEqual(nodeByKeyPart(nodes, "sg-aaa").capabilities, []);
});

test("edges come ONLY from real relationships (attached role + security groups)", () => {
  const { edges } = buildGraph(sandboxFindings());
  // The EC2 instance yields exactly: 1 uses_role + 2 in_security_group.
  assert.equal(edges.length, 3);

  const instanceKey =
    "ec2_instance:arn:aws:ec2:us-east-1:111122223333:instance/i-0xyz";
  const roleEdges = edges.filter((e) => e.relation === "uses_role");
  assert.equal(roleEdges.length, 1);
  assert.equal(roleEdges[0].srcKey, instanceKey);
  assert.ok(roleEdges[0].dstKey.endsWith("role/app-role"));
  assert.equal(roleEdges[0].evidence.checkId, "ec2_instance_imdsv2_enabled");

  const sgEdges = edges.filter((e) => e.relation === "in_security_group");
  assert.equal(sgEdges.length, 2);
  assert.ok(sgEdges.every((e) => e.srcKey === instanceKey));
});

test("never invents edges from co-location", () => {
  // The open SG and the public bucket are both flagged but unrelated in the data.
  const { edges } = buildGraph([
    {
      ...sandboxFindings()[0], // public S3 bucket
    },
    {
      ...sandboxFindings()[2], // open security group
    },
  ]);
  assert.equal(edges.length, 0);
});

test("ignores non-fail findings and is empty for no input", () => {
  assert.deepEqual(buildGraph([]), { nodes: [], edges: [] });

  const passing = mk({
    checkId: "s3_bucket_public_access",
    resourceType: "AwsS3Bucket",
    resourceId: "arn:aws:s3:::passing",
    status: "pass",
  });
  const { nodes, edges } = buildGraph([passing]);
  assert.equal(nodes.length, 0);
  assert.equal(edges.length, 0);
});

test("deduplicates a repeated relationship edge", () => {
  // Same instance lists the same SG in two findings -> ONE edge.
  const rel: RelatedResource = {
    type: "AwsEc2SecurityGroup",
    id: "arn:aws:ec2:us-east-1:111122223333:security-group/sg-dup",
  };
  const findings = [
    mk({
      checkId: "ec2_instance_imdsv2_enabled",
      resourceType: "AwsEc2Instance",
      resourceId: "i-dup",
      relatedResources: [rel],
    }),
    mk({
      checkId: "ec2_instance_detailed_monitoring_enabled",
      resourceType: "AwsEc2Instance",
      resourceId: "i-dup",
      relatedResources: [rel],
    }),
  ];
  const { edges } = buildGraph(findings);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relation, "in_security_group");
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAttackPaths,
  type PathEdge,
  type PathNode,
} from "./paths.ts";

function node(
  nodeKey: string,
  type: string,
  capabilities: string[],
  name?: string,
): PathNode {
  return { nodeKey, type, name: name ?? null, capabilities };
}

test("single-resource combo: public bucket + holds_data -> critical path (medium confidence)", () => {
  const bucket = node(
    "s3_bucket:arn:aws:s3:::acme-public",
    "s3_bucket",
    ["publicly_accessible", "holds_data"],
    "acme-public",
  );
  const paths = buildAttackPaths([bucket], []);

  const pde = paths.find((p) => p.ruleId === "public-data-exposure");
  assert.ok(pde, "expected a public-data-exposure path");
  assert.equal(pde.severity, "critical");
  assert.equal(pde.confidence, "medium"); // same-resource heuristic, no edge
  assert.equal(pde.entryKey, bucket.nodeKey);
  assert.equal(pde.targetKey, bucket.nodeKey);
  assert.deepEqual(pde.hops.nodes, [bucket.nodeKey]);
  assert.equal(pde.hops.edges.length, 0);
});

test("public RDS fires BOTH public-data-exposure (critical) and public-database (high)", () => {
  const rds = node(
    "rds_db_instance:arn:aws:rds:us-east-1:111122223333:db:prod-db",
    "rds_db_instance",
    ["publicly_accessible", "holds_data"],
    "prod-db",
  );
  const paths = buildAttackPaths([rds], []);

  const exposure = paths.find((p) => p.ruleId === "public-data-exposure");
  const database = paths.find((p) => p.ruleId === "public-database");
  assert.ok(exposure, "expected public-data-exposure");
  assert.equal(exposure.severity, "critical");
  assert.ok(database, "expected public-database");
  assert.equal(database.severity, "high");
});

test("no-paths case: lone weak_auth + lone unencrypted match no rule", () => {
  const user = node("iam_user:arn:aws:iam::1:user/alice", "iam_user", [
    "weak_auth",
  ]);
  const ebs = node("ec2_volume:vol-1", "ec2_volume", ["unencrypted"]);
  assert.deepEqual(buildAttackPaths([user, ebs], []), []);
});

test("multi-hop: exposed SG -> instance -> privileged role fires via UNDIRECTED traversal (confidence high)", () => {
  // Stored edges point instance->sg and instance->role; the engine must still
  // reach the role starting from the exposed security group.
  const sg = node(
    "ec2_security_group:arn:aws:ec2:us-east-1:1:security-group/sg-open",
    "ec2_security_group",
    ["exposed_internet"],
    "sg-open",
  );
  const inst = node(
    "ec2_instance:arn:aws:ec2:us-east-1:1:instance/i-1",
    "ec2_instance",
    [],
    "i-1",
  );
  const role = node(
    "iam_role:arn:aws:iam::1:role/app",
    "iam_role",
    ["privileged"],
    "app",
  );
  const edges: PathEdge[] = [
    { srcKey: inst.nodeKey, dstKey: sg.nodeKey, relation: "in_security_group" },
    { srcKey: inst.nodeKey, dstKey: role.nodeKey, relation: "uses_role" },
  ];

  const paths = buildAttackPaths([sg, inst, role], edges);
  const p = paths.find(
    (x) => x.ruleId === "internet-compute-to-privileged-role",
  );
  assert.ok(p, "expected internet-compute-to-privileged-role path");
  assert.equal(p.severity, "critical");
  assert.equal(p.confidence, "high"); // used a real edge
  assert.equal(p.entryKey, sg.nodeKey);
  assert.equal(p.targetKey, role.nodeKey);
  assert.deepEqual(p.hops.nodes, [sg.nodeKey, inst.nodeKey, role.nodeKey]);
  assert.equal(p.hops.edges.length, 2);
});

test("relational rule does not fire when the target is unreachable within max hops", () => {
  // Exposed SG and a privileged role, but NO edges connecting them.
  const sg = node("ec2_security_group:sg-x", "ec2_security_group", [
    "exposed_internet",
  ]);
  const role = node("iam_role:role-x", "iam_role", ["privileged"]);
  const paths = buildAttackPaths([sg, role], []);
  assert.equal(
    paths.some((p) => p.ruleId === "internet-compute-to-privileged-role"),
    false,
  );
});

test("blind-spot amplifier flags critical paths when the account is logging-blind", () => {
  const bucket = node(
    "s3_bucket:arn:aws:s3:::acme",
    "s3_bucket",
    ["publicly_accessible", "holds_data"],
    "acme",
  );
  const trail = node("cloudtrail:trail", "cloudtrail", ["logging_blind"]);

  const paths = buildAttackPaths([bucket, trail], []);
  const pde = paths.find((p) => p.ruleId === "public-data-exposure");
  assert.ok(pde);
  assert.equal(pde.hops.blindSpot, true);
  assert.ok(pde.capabilities.includes("logging_blind"));
});

test("ranks critical before high, and dedupes identical matches", () => {
  const bucket = node(
    "s3_bucket:b",
    "s3_bucket",
    ["publicly_accessible", "holds_data"],
  ); // critical
  const role = node("iam_role:r", "iam_role", ["privileged"]); // high
  const paths = buildAttackPaths([bucket, role], []);
  assert.equal(paths[0].severity, "critical");
  // A single bucket yields exactly one public-data-exposure entry (deduped).
  assert.equal(
    paths.filter((p) => p.ruleId === "public-data-exposure").length,
    1,
  );
});

test("caps output at 50 paths", () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    node(`s3_bucket:b${i}`, "s3_bucket", ["publicly_accessible", "holds_data"], `b${i}`),
  );
  assert.equal(buildAttackPaths(many, []).length, 50);
});

/* ---------------------- AP-5: PMapper identity chains ---------------------- */

test("identity multi-hop: alice -> intermediate -> admin fires privilege-escalation-chain (high, directed)", () => {
  // PMapper-style directed can_assume edges (source can assume destination).
  const alice = node("iam_user:alice", "iam_user", [], "alice");
  const inter = node("iam_role:intermediate", "iam_role", [], "intermediate");
  const admin = node("iam_role:admin", "iam_role", ["privileged"], "admin");
  const edges: PathEdge[] = [
    { srcKey: alice.nodeKey, dstKey: inter.nodeKey, relation: "can_assume" },
    { srcKey: inter.nodeKey, dstKey: admin.nodeKey, relation: "can_assume" },
  ];

  const paths = buildAttackPaths([alice, inter, admin], edges);
  const chain = paths.find(
    (p) =>
      p.ruleId === "privilege-escalation-chain" &&
      p.entryKey === alice.nodeKey &&
      p.targetKey === admin.nodeKey,
  );
  assert.ok(chain, "expected alice → admin escalation chain");
  assert.equal(chain.severity, "high");
  assert.equal(chain.confidence, "high"); // real PMapper edges
  assert.deepEqual(chain.hops.nodes, [alice.nodeKey, inter.nodeKey, admin.nodeKey]);
  assert.equal(chain.hops.edges.length, 2);
});

test("escalation traversal is DIRECTED — admin does not 'escalate' backward to a non-admin", () => {
  // Only edge: alice can_assume admin. Reverse direction must not yield a path.
  const alice = node("iam_user:alice", "iam_user", [], "alice");
  const admin = node("iam_role:admin", "iam_role", ["privileged"], "admin");
  const edges: PathEdge[] = [
    { srcKey: alice.nodeKey, dstKey: admin.nodeKey, relation: "can_assume" },
  ];
  const paths = buildAttackPaths([alice, admin], edges);
  // alice -> admin fires; there is no admin -> alice escalation (alice isn't privileged anyway).
  const chains = paths.filter((p) => p.ruleId === "privilege-escalation-chain");
  assert.equal(chains.length, 1);
  assert.equal(chains[0].entryKey, alice.nodeKey);
  assert.equal(chains[0].targetKey, admin.nodeKey);
});

test("wildcard-trust-admin-role activates when PMapper supplies privileged + wildcard_trust", () => {
  const admin = node("iam_role:admin", "iam_role", ["privileged", "wildcard_trust"], "admin");
  const paths = buildAttackPaths([admin], []);
  const wt = paths.find((p) => p.ruleId === "wildcard-trust-admin-role");
  assert.ok(wt, "wildcard-trust-admin-role should fire");
  assert.equal(wt.severity, "critical");

  // Without the wildcard_trust signal (Prowler-only) it stays dormant.
  const adminNoTrust = node("iam_role:admin2", "iam_role", ["privileged"], "admin2");
  assert.equal(
    buildAttackPaths([adminNoTrust], []).some(
      (p) => p.ruleId === "wildcard-trust-admin-role",
    ),
    false,
  );
});

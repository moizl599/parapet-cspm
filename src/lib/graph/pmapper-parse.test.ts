import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePmapperGraph, mergeGraphs } from "./pmapper-parse.ts";
import type { GraphNode } from "./tagging.ts";

const ACC = "111122223333";
const USER = `arn:aws:iam::${ACC}:user/alice`;
const INT = `arn:aws:iam::${ACC}:role/intermediate`;
const ADMIN = `arn:aws:iam::${ACC}:role/app-admin`;

/** A small PMapper graph: alice -> intermediate -> app-admin (admin, wildcard trust). */
const SAMPLE_PMAPPER = {
  nodes: [
    { arn: USER, id_value: "alice", is_admin: false },
    { arn: INT, id_value: "intermediate", is_admin: false },
    {
      arn: ADMIN,
      id_value: "app-admin",
      is_admin: true,
      trust_policy: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Principal: { AWS: "*" }, Action: "sts:AssumeRole" },
        ],
      },
    },
  ],
  edges: [
    {
      source: USER,
      destination: INT,
      reason: "can call sts:AssumeRole to access",
      short_reason: "can access via sts:AssumeRole",
    },
    {
      source: INT,
      destination: ADMIN,
      reason: "can call sts:AssumeRole to access",
      short_reason: "can access via sts:AssumeRole",
    },
  ],
};

test("parses PMapper nodes with iam_role/iam_user keys matching Prowler tokens", () => {
  const { nodes } = parsePmapperGraph(SAMPLE_PMAPPER);
  assert.equal(nodes.length, 3);
  const admin = nodes.find((n) => n.nodeKey === `iam_role:${ADMIN}`);
  assert.ok(admin, "admin role node should use the iam_role:<arn> key");
  assert.equal(admin.type, "iam_role");
  assert.equal(admin.accountId, ACC);
  assert.equal(admin.source, "pmapper");
  // is_admin -> privileged; wildcard trust -> wildcard_trust.
  assert.ok(admin.capabilities.includes("privileged"));
  assert.ok(admin.capabilities.includes("wildcard_trust"));

  const alice = nodes.find((n) => n.nodeKey === `iam_user:${USER}`);
  assert.ok(alice);
  assert.deepEqual(alice.capabilities, []);
});

test("parses PMapper edges, classifying sts:AssumeRole as can_assume", () => {
  const { edges } = parsePmapperGraph(SAMPLE_PMAPPER);
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.relation, "can_assume");
    assert.equal(e.source, "pmapper");
  }
  assert.ok(
    edges.some((e) => e.srcKey === `iam_user:${USER}` && e.dstKey === `iam_role:${INT}`),
  );
});

test("non-assume reasons classify as can_access; never throws on junk", () => {
  const { edges } = parsePmapperGraph({
    nodes: [{ arn: USER }, { arn: ADMIN, is_admin: true }],
    edges: [{ source: USER, destination: ADMIN, short_reason: "can use permission X" }],
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relation, "can_access");

  // Junk input -> empty, no throw.
  assert.deepEqual(parsePmapperGraph(null), { nodes: [], edges: [] });
  assert.deepEqual(parsePmapperGraph({ nodes: "x", edges: 5 }), {
    nodes: [],
    edges: [],
  });
});

test("mergeGraphs unions capabilities (Prowler + PMapper) and edges by key", () => {
  // Prowler already tagged the admin role privileged (via administrative_privileges).
  const base = {
    nodes: [
      {
        nodeKey: `iam_role:${ADMIN}`,
        type: "iam_role",
        name: "app-admin",
        region: "us-east-2",
        accountId: ACC,
        capabilities: ["privileged"],
        source: "prowler",
      } as GraphNode,
    ],
    edges: [],
  };
  const overlay = parsePmapperGraph(SAMPLE_PMAPPER);
  const merged = mergeGraphs(base, overlay);

  const admin = merged.nodes.find((n) => n.nodeKey === `iam_role:${ADMIN}`);
  assert.ok(admin);
  // privileged (from Prowler) + wildcard_trust (from PMapper), deduped.
  assert.ok(admin.capabilities.includes("privileged"));
  assert.ok(admin.capabilities.includes("wildcard_trust"));
  assert.equal(admin.capabilities.filter((c) => c === "privileged").length, 1);
  // The Prowler node kept its region; PMapper edges came across.
  assert.equal(admin.region, "us-east-2");
  assert.equal(merged.edges.length, 2);
});

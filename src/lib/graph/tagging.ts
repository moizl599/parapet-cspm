/**
 * Attack-path graph: capability tagging + edge derivation (AP-1).
 *
 * PURE and deterministic (no I/O, no LLM, no network) — unit-tested with
 * fixtures. Turns a scan's FAILED findings into:
 *   - graph_nodes: one per distinct resource, tagged with security capabilities
 *     via the mapping in docs/ATTACK_PATHS_DESIGN.md ("Capability tagging").
 *   - graph_edges: ONLY from relationships actually present in the finding detail
 *     (a resource's attached role / security groups). NEVER from co-location —
 *     two flagged resources in the same scan get no edge unless the data links
 *     them. This keeps v1 honest (see the design doc's "Edges" section).
 *
 * The path engine + rules come later (AP-2); this module stops at nodes + edges.
 */
import type { Finding, RelatedResource } from "@/lib/ocsf";

export type Capability =
  | "exposed_internet"
  | "publicly_accessible"
  | "privileged"
  | "holds_data"
  | "unencrypted"
  | "weak_auth"
  | "credential_exposure"
  | "logging_blind"
  /** PMapper (AP-5): a privileged role whose trust allows broad principals. */
  | "wildcard_trust";

/** Prowler-derived relations (uses_role/in_security_group) + PMapper IAM
 *  relations (can_assume/can_access). */
export type EdgeRelation =
  | "uses_role"
  | "in_security_group"
  | "can_assume"
  | "can_access";

/** Which scanner produced a node/edge. */
export type GraphSource = "prowler" | "pmapper";

export interface GraphNode {
  /** Stable: normalized type + resource id. */
  nodeKey: string;
  type: string;
  name: string | null;
  region: string | null;
  accountId: string | null;
  capabilities: Capability[];
  source: GraphSource;
}

export interface GraphEdge {
  srcKey: string;
  dstKey: string;
  relation: EdgeRelation;
  /** Finding (Prowler) or PMapper fact that produced this edge. */
  evidence: { checkId?: string; title?: string; reason?: string };
  source: GraphSource;
}

export interface GraphBuildResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* --------------------------------- helpers -------------------------------- */

/** "AwsS3Bucket" -> "s3_bucket"; "AwsEc2SecurityGroup" -> "ec2_security_group". */
function normalizeType(resourceType: string): string {
  const t = (resourceType || "")
    .replace(/^aws/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return t || "resource";
}

/** Short, human-friendly name from an ARN / id (last path or colon segment). */
function shortName(id: string): string {
  const afterSlash = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const afterColon = afterSlash.includes(":")
    ? afterSlash.slice(afterSlash.lastIndexOf(":") + 1)
    : afterSlash;
  return afterColon || id;
}

function nodeKeyFor(resourceType: string, resourceId: string): string {
  return `${normalizeType(resourceType)}:${resourceId}`;
}

/* ----------------------------- capability rules --------------------------- */

interface CapInput {
  checkId: string; // lowercased
  service: string; // lowercased
  resourceType: string; // lowercased
}

interface CapRule {
  cap: Capability;
  test: (f: CapInput) => boolean;
}

// Data-store resource types -> holds_data (a POTENTIAL-sensitivity heuristic by
// type; the LLM must hedge — see the design doc).
function isDataStore(resourceType: string): boolean {
  return (
    /s3bucket/.test(resourceType) ||
    /\brds\b|rdsdb|dbinstance|dbcluster/.test(resourceType) ||
    /dynamodb/.test(resourceType) ||
    /redshift/.test(resourceType) ||
    /efs|elasticfilesystem/.test(resourceType) ||
    /secretsmanager/.test(resourceType) ||
    /sqs/.test(resourceType)
  );
}

// Match check_id by prefix/glob (extend over time). Order is irrelevant — every
// matching rule contributes its tag (a finding can yield several).
const CAP_RULES: CapRule[] = [
  {
    cap: "exposed_internet",
    test: ({ checkId }) =>
      /^ec2_securitygroup_allow_ingress_from_internet/.test(checkId) ||
      /internet_facing/.test(checkId) ||
      /(elb|elbv2|alb)_.*internet/.test(checkId),
  },
  {
    cap: "publicly_accessible",
    test: ({ checkId }) =>
      /^s3_bucket_public/.test(checkId) ||
      checkId === "s3_account_level_public_access_blocks" ||
      checkId === "rds_instance_no_public_access" ||
      /(opensearch|elasticsearch|redshift|sns|sqs).*public/.test(checkId) ||
      /_publicly_accessible/.test(checkId),
  },
  {
    cap: "privileged",
    test: ({ checkId }) =>
      /^iam_.*administrator/.test(checkId) ||
      checkId === "iam_policy_allows_privilege_escalation" ||
      /full_administrative_privileges/.test(checkId) ||
      // Prowler's actual wording for "admin policy" checks, e.g.
      // iam_aws_attached_policy_no_administrative_privileges.
      /administrative_privileges/.test(checkId) ||
      /privilege_escalation/.test(checkId) ||
      /root_account/.test(checkId),
  },
  {
    cap: "holds_data",
    test: ({ resourceType }) => isDataStore(resourceType),
  },
  {
    cap: "unencrypted",
    test: ({ checkId }) => /encrypt/.test(checkId),
  },
  {
    // IDENTITY weak-auth only. Anchoring to iam_/account_ deliberately excludes
    // non-identity findings that merely mention "mfa": S3 MFA-delete
    // (s3_bucket_*_mfa_delete) and the CloudWatch CIS "metric filter ... without
    // MFA" log-metric checks (cloudwatch_*/cloudtrail_*), which are not auth
    // strength on an identity.
    cap: "weak_auth",
    test: ({ checkId }) =>
      /^iam_.*mfa/.test(checkId) ||
      /^iam_.*password_policy/.test(checkId) ||
      /^account_.*password_policy/.test(checkId),
  },
  {
    cap: "credential_exposure",
    test: ({ checkId }) =>
      (/access_key/.test(checkId) && /(rotat|unused|exposed|age)/.test(checkId)) ||
      /hardcoded/.test(checkId) ||
      /secret.*expos/.test(checkId),
  },
  {
    cap: "logging_blind",
    test: ({ checkId }) => /^cloudtrail/.test(checkId) || /flow_log/.test(checkId),
  },
];

// Stable output order for tags so tests/diffs are deterministic.
const CAP_ORDER: Capability[] = [
  "exposed_internet",
  "publicly_accessible",
  "privileged",
  "holds_data",
  "unencrypted",
  "weak_auth",
  "credential_exposure",
  "logging_blind",
];

function capabilitiesFor(f: Finding): Capability[] {
  const input: CapInput = {
    checkId: (f.checkId ?? "").toLowerCase(),
    service: (f.service ?? "").toLowerCase(),
    resourceType: (f.resourceType ?? "").toLowerCase(),
  };
  return CAP_RULES.filter((r) => r.test(input)).map((r) => r.cap);
}

/* ------------------------------ edge inference ---------------------------- */

/** Classify a related resource into a real edge relation, or null (ignored). */
function relationFor(
  rel: RelatedResource,
): { relation: EdgeRelation; type: string } | null {
  const id = rel.id;
  const type = (rel.type || "").toLowerCase();
  if (/:role\//.test(id) || /iam.*role|^role$/.test(type)) {
    return { relation: "uses_role", type: "iam_role" };
  }
  if (/:security-group\//.test(id) || /securitygroup|security_group/.test(type)) {
    return { relation: "in_security_group", type: "security_group" };
  }
  return null; // not a relationship we can honestly turn into an edge
}

/* --------------------------------- builder -------------------------------- */

/**
 * Build the per-scan graph from FAILED findings. Caller should pass only
 * `status === "fail"` findings (the design tags from failed findings).
 */
export function buildGraph(findings: Finding[]): GraphBuildResult {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  // Merge capabilities onto a node, creating it if needed.
  const upsertNode = (
    nodeKey: string,
    type: string,
    name: string | null,
    region: string | null,
    accountId: string | null,
    caps: Capability[],
  ): void => {
    const existing = nodes.get(nodeKey);
    if (existing) {
      for (const c of caps) {
        if (!existing.capabilities.includes(c)) existing.capabilities.push(c);
      }
      // Backfill missing descriptive fields from a later finding.
      if (!existing.name && name) existing.name = name;
      if (!existing.region && region) existing.region = region;
      if (!existing.accountId && accountId) existing.accountId = accountId;
      return;
    }
    nodes.set(nodeKey, {
      nodeKey,
      type,
      name,
      region,
      accountId,
      capabilities: [...caps],
      source: "prowler",
    });
  };

  for (const f of findings) {
    if (f.status !== "fail") continue;

    const region = f.region || null;
    const accountId = f.accountId ?? null;
    const primaryKey = nodeKeyFor(f.resourceType, f.resourceId);
    upsertNode(
      primaryKey,
      normalizeType(f.resourceType),
      shortName(f.resourceId),
      region,
      accountId,
      capabilitiesFor(f),
    );

    // Edges + endpoint nodes — ONLY for related roles / security groups.
    for (const rel of f.relatedResources ?? []) {
      const classified = relationFor(rel);
      if (!classified) continue;
      // Prefer the related resource's own type; fall back to the canonical token.
      const dstType = rel.type ? normalizeType(rel.type) : classified.type;
      const dstKey = `${dstType}:${rel.id}`;
      // Ensure the endpoint exists as a node (no capabilities unless it's also
      // a primary resource elsewhere — handled by upsert merge).
      upsertNode(dstKey, dstType, shortName(rel.id), region, accountId, []);

      const edgeKey = `${primaryKey}|${dstKey}|${classified.relation}`;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          srcKey: primaryKey,
          dstKey,
          relation: classified.relation,
          evidence: { checkId: f.checkId, title: f.checkTitle },
          source: "prowler",
        });
      }
    }
  }

  // Sort each node's capabilities into the canonical order.
  for (const node of nodes.values()) {
    node.capabilities.sort(
      (a, b) => CAP_ORDER.indexOf(a) - CAP_ORDER.indexOf(b),
    );
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

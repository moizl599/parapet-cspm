/**
 * PMapper graph parsing (AP-5) — PURE, no I/O, unit-tested with a fixture.
 *
 * Converts PMapper's (nccgroup/PMapper) IAM authorization graph into our
 * graph_nodes / graph_edges with `source: "pmapper"`. PMapper is the authority
 * on IAM identity relationships — who can assume/access whom — which Prowler's
 * per-finding output does not carry. Merging these in BEFORE the path engine
 * runs is what turns single-resource combos into real identity multi-hop chains.
 *
 * PMapper output is UNTRUSTED external-tool output, so parsing never throws —
 * malformed nodes/edges are skipped.
 *
 * Expected input shape (PMapper's Graph JSON; we read a tolerant subset):
 *   { nodes: [{ arn, id_value?, is_admin?, trust_policy? }],
 *     edges: [{ source, destination, reason?, short_reason? }] }
 */
import type { Capability, GraphEdge, GraphNode } from "@/lib/graph/tagging";

export interface PMapperNode {
  arn?: string;
  id_value?: string;
  is_admin?: boolean;
  /** Role trust policy (used to flag wildcard/broad trust). */
  trust_policy?: unknown;
}
export interface PMapperEdge {
  source?: string;
  destination?: string;
  reason?: string;
  short_reason?: string;
}
export interface PMapperGraph {
  nodes?: PMapperNode[];
  edges?: PMapperEdge[];
}

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** IAM identity type token from an ARN — matches Prowler's normalized tokens
 *  (iam_role / iam_user) so PMapper nodes MERGE with Prowler nodes by key. */
function typeFromArn(arn: string): string {
  if (/:role\//.test(arn)) return "iam_role";
  if (/:user\//.test(arn)) return "iam_user";
  if (/:group\//.test(arn)) return "iam_group";
  if (/:root$/.test(arn)) return "iam_root";
  return "iam_identity";
}

function accountFromArn(arn: string): string | null {
  const parts = arn.split(":");
  return parts.length >= 5 && parts[4] ? parts[4] : null;
}

function shortName(arn: string): string {
  const afterSlash = arn.includes("/") ? arn.slice(arn.lastIndexOf("/") + 1) : arn;
  return afterSlash.includes(":")
    ? afterSlash.slice(afterSlash.lastIndexOf(":") + 1)
    : afterSlash || arn;
}

const nodeKeyForArn = (arn: string): string => `${typeFromArn(arn)}:${arn}`;

/** True when a role trust policy allows a broad / wildcard principal. */
function hasWildcardTrust(trustPolicy: unknown): boolean {
  const doc = isRecord(trustPolicy) ? trustPolicy : null;
  if (!doc) return false;
  const raw = doc.Statement ?? doc.statement;
  const statements = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const s of statements) {
    if (!isRecord(s)) continue;
    if (typeof s.Effect === "string" && s.Effect.toLowerCase() !== "allow") continue;
    const principal = s.Principal ?? s.principal;
    if (principal === "*") return true;
    if (isRecord(principal)) {
      for (const v of Object.values(principal)) {
        if (v === "*") return true;
        if (Array.isArray(v) && v.includes("*")) return true;
      }
    }
  }
  return false;
}

/** Classify a PMapper edge reason into an IAM relation. */
function relationFromReason(reason: string): "can_assume" | "can_access" {
  return /assume/i.test(reason) ? "can_assume" : "can_access";
}

/** Parse a PMapper graph into our node/edge model. Never throws. */
export function parsePmapperGraph(raw: unknown): ParsedGraph {
  const graph = isRecord(raw) ? (raw as PMapperGraph) : {};
  const nodes = new Map<string, GraphNode>();

  for (const n of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (!isRecord(n)) continue;
    const arn = typeof n.arn === "string" ? n.arn : "";
    if (!arn) continue;
    const caps: Capability[] = [];
    if (n.is_admin === true) caps.push("privileged");
    if (hasWildcardTrust(n.trust_policy)) caps.push("wildcard_trust");
    nodes.set(nodeKeyForArn(arn), {
      nodeKey: nodeKeyForArn(arn),
      type: typeFromArn(arn),
      name: typeof n.id_value === "string" && n.id_value ? n.id_value : shortName(arn),
      region: null, // IAM is global
      accountId: accountFromArn(arn),
      capabilities: caps,
      source: "pmapper",
    });
  }

  const edges = new Map<string, GraphEdge>();
  for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
    if (!isRecord(e)) continue;
    const src = typeof e.source === "string" ? e.source : "";
    const dst = typeof e.destination === "string" ? e.destination : "";
    if (!src || !dst) continue;
    const reason =
      (typeof e.short_reason === "string" && e.short_reason) ||
      (typeof e.reason === "string" && e.reason) ||
      "";
    const relation = relationFromReason(reason);
    const srcKey = nodeKeyForArn(src);
    const dstKey = nodeKeyForArn(dst);
    const key = `${srcKey}|${dstKey}|${relation}`;
    if (!edges.has(key)) {
      edges.set(key, {
        srcKey,
        dstKey,
        relation,
        evidence: { reason: reason || "PMapper IAM relationship" },
        source: "pmapper",
      });
    }
    // Ensure endpoint nodes exist even if not listed in `nodes` (defensive).
    for (const [k, a] of [
      [srcKey, src],
      [dstKey, dst],
    ] as const) {
      if (!nodes.has(k)) {
        nodes.set(k, {
          nodeKey: k,
          type: typeFromArn(a),
          name: shortName(a),
          region: null,
          accountId: accountFromArn(a),
          capabilities: [],
          source: "pmapper",
        });
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Merge a base graph (Prowler) with an overlay (PMapper). Nodes union by
 * node_key (capabilities unioned; descriptive fields backfilled). Edges union,
 * deduped by src|dst|relation. The base node's `source` is preserved when a key
 * exists in both (it's the directly-flagged resource).
 */
export function mergeGraphs(base: ParsedGraph, overlay: ParsedGraph): ParsedGraph {
  const nodes = new Map<string, GraphNode>();
  for (const n of base.nodes) nodes.set(n.nodeKey, { ...n, capabilities: [...n.capabilities] });
  for (const n of overlay.nodes) {
    const existing = nodes.get(n.nodeKey);
    if (!existing) {
      nodes.set(n.nodeKey, { ...n, capabilities: [...n.capabilities] });
      continue;
    }
    for (const c of n.capabilities) {
      if (!existing.capabilities.includes(c)) existing.capabilities.push(c);
    }
    if (!existing.name && n.name) existing.name = n.name;
    if (!existing.region && n.region) existing.region = n.region;
    if (!existing.accountId && n.accountId) existing.accountId = n.accountId;
  }

  const edges = new Map<string, GraphEdge>();
  for (const e of [...base.edges, ...overlay.edges]) {
    const key = `${e.srcKey}|${e.dstKey}|${e.relation}`;
    if (!edges.has(key)) edges.set(key, e);
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Attack-path API serialization (AP-4) — PURE, no server-only, no I/O.
 *
 * Shared shape between the server route and the client. Joins persisted
 * attack_paths rows with the scan's graph nodes so the UI can render each path's
 * chain with capability-tagged nodes without a second lookup. Mirrors the
 * env-dto pattern (client imports the TYPES only).
 */
import type { AttackPathRow, GraphNodeRow } from "@/lib/db/schema";
import type { AttackPathHops } from "@/lib/graph/paths";

export type PathSeverity = "critical" | "high" | "medium" | "low";
export type PathConfidence = "high" | "medium" | "low";
export type Effort = "quick-win" | "moderate" | "involved";

export interface BreakTheChainStep {
  link: string;
  action: string;
  effort: Effort;
}

export interface PathNarrative {
  summary: string;
  attack_scenario: string;
  blast_radius: string;
  severity_rationale: string;
  break_the_chain: BreakTheChainStep[];
  confidence_note: string;
  false_positive_risk: "low" | "medium" | "high";
}

export interface AttackPathNodeDto {
  key: string;
  type: string;
  name: string;
  capabilities: string[];
}

export interface AttackPathEdgeDto {
  srcKey: string;
  dstKey: string;
  relation: string;
}

export interface AttackPathDto {
  id: number;
  ruleId: string;
  title: string;
  severity: PathSeverity;
  confidence: PathConfidence;
  entryKey: string | null;
  targetKey: string | null;
  /** Ordered entry → target, enriched with each node's type + capabilities. */
  nodes: AttackPathNodeDto[];
  edges: AttackPathEdgeDto[];
  capabilities: string[];
  /** Account is logging-blind → this (critical) path would go unseen. */
  blindSpot: boolean;
  /** LLM narrative; null for lower-priority paths beyond the top-N (AP-3). */
  narrative: PathNarrative | null;
}

export interface PathsResponse {
  paths: AttackPathDto[];
  /** Total computed paths. */
  total: number;
  /** How many are critical. */
  critical: number;
}

const SEV_RANK: Record<PathSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const CONF_RANK: Record<PathConfidence, number> = { high: 0, medium: 1, low: 2 };

/** Type token from a node_key "type:resourceId" (defensive fallback). */
function keyType(key: string): string {
  const i = key.indexOf(":");
  return i > 0 ? key.slice(0, i) : "resource";
}
/** Short display name from a node_key's resource id. */
function keyName(key: string): string {
  const id = key.slice(key.indexOf(":") + 1);
  const afterSlash = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return afterSlash.includes(":")
    ? afterSlash.slice(afterSlash.lastIndexOf(":") + 1)
    : afterSlash || id;
}

/** Map persisted rows + the scan's graph nodes into ranked client DTOs. */
export function toAttackPathDtos(
  rows: AttackPathRow[],
  nodes: GraphNodeRow[],
): AttackPathDto[] {
  const nodeByKey = new Map(nodes.map((n) => [n.nodeKey, n]));

  const dtos: AttackPathDto[] = rows.map((r) => {
    const hops = (r.hops as AttackPathHops | null) ?? { nodes: [], edges: [] };
    return {
      id: r.id,
      ruleId: r.ruleId,
      title: r.title ?? r.ruleId,
      severity: r.severity as PathSeverity,
      confidence: (r.confidence ?? "medium") as PathConfidence,
      entryKey: r.entryKey,
      targetKey: r.targetKey,
      nodes: (hops.nodes ?? []).map((k) => {
        const n = nodeByKey.get(k);
        return {
          key: k,
          type: n?.type ?? keyType(k),
          name: n?.name ?? keyName(k),
          capabilities: (n?.capabilities ?? []) as string[],
        };
      }),
      edges: (hops.edges ?? []).map((e) => ({
        srcKey: e.srcKey,
        dstKey: e.dstKey,
        relation: e.relation,
      })),
      capabilities: (r.capabilities ?? []) as string[],
      blindSpot: hops.blindSpot === true,
      narrative: (r.narrative as PathNarrative | null) ?? null,
    };
  });

  // Rank by severity then confidence (defensive — the engine already ranks).
  dtos.sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      CONF_RANK[a.confidence] - CONF_RANK[b.confidence],
  );
  return dtos;
}

/**
 * Attack-path engine (AP-2).
 *
 * PURE and deterministic (no I/O, no LLM, no network) — unit-tested with
 * fixtures. Given a scan's graph (nodes + edges from src/lib/graph/tagging.ts),
 * matches the toxic-combination rule set from docs/ATTACK_PATHS_DESIGN.md and
 * emits attack paths. The LLM only NARRATES these later (AP-3) — it never
 * invents one.
 *
 * Two rule shapes:
 *   - single  : a pattern over ONE node's capabilities (confidence = medium —
 *               a heuristic same-resource combo).
 *   - relational: an exposed entry node that REACHES a sensitive/privileged
 *               target over real edges (bounded BFS, ≤ MAX_HOPS). Edges are
 *               traversed UNDIRECTED — an exposed security group must connect to
 *               its instance and onward to that instance's role even though the
 *               stored edge points instance→sg / instance→role. Confidence =
 *               high because the link is a real relationship in the data.
 *
 * The blind-spot amplifier (account `logging_blind`) is not a path; it flags
 * critical paths as "the attack would go unseen" (raises urgency).
 */

export type PathSeverity = "critical" | "high" | "medium" | "low";
export type PathConfidence = "high" | "medium" | "low";

/** Minimal node/edge shapes so this accepts both the in-memory graph
 *  (GraphNode/GraphEdge) and the persisted rows (GraphNodeRow/GraphEdgeRow). */
export interface PathNode {
  nodeKey: string;
  type: string;
  name?: string | null;
  capabilities: string[];
}
export interface PathEdge {
  srcKey: string;
  dstKey: string;
  relation: string;
}

export interface AttackPathHops {
  /** Ordered node_keys, entry → target. */
  nodes: string[];
  edges: { srcKey: string; dstKey: string; relation: string }[];
  /** Account is logging-blind → this (critical) path would go unseen. */
  blindSpot?: boolean;
}

export interface AttackPath {
  ruleId: string;
  title: string;
  severity: PathSeverity;
  entryKey: string | null;
  targetKey: string | null;
  hops: AttackPathHops;
  capabilities: string[];
  confidence: PathConfidence;
}

const MAX_HOPS = 4;
const MAX_PATHS = 50;

/* --------------------------------- helpers -------------------------------- */

const has = (n: PathNode, cap: string): boolean => n.capabilities.includes(cap);

/** Database resource types (narrower than holds_data) for `public-database`. */
function isDatabaseType(type: string): boolean {
  return /rds|dynamodb|redshift|docdb|neptune|aurora|(^|_)db(_|$)|database/.test(
    type,
  );
}

function displayName(n: PathNode | undefined): string {
  return n?.name ?? n?.nodeKey ?? "unknown";
}

/* ----------------------------- declarative rules -------------------------- */

interface SingleRule {
  kind: "single";
  id: string;
  severity: PathSeverity;
  title: string;
  predicate: (n: PathNode) => boolean;
}
interface RelationalRule {
  kind: "relational";
  id: string;
  severity: PathSeverity;
  title: string;
  entry: (n: PathNode) => boolean;
  target: (n: PathNode) => boolean;
}
type Rule = SingleRule | RelationalRule;

// Add rules here — the engine picks them up automatically.
const RULES: Rule[] = [
  {
    kind: "single",
    id: "public-data-exposure",
    severity: "critical",
    title: "Public data store",
    predicate: (n) => has(n, "publicly_accessible") && has(n, "holds_data"),
  },
  {
    kind: "relational",
    id: "internet-compute-to-privileged-role",
    severity: "critical",
    title: "Internet-exposed compute reaches a privileged role",
    entry: (n) => has(n, "exposed_internet"),
    target: (n) => has(n, "privileged"),
  },
  {
    // Dormant until trust-policy data exists (a `wildcard_trust` signal from a
    // future finding/PMapper, AP-5). Encoded now so it lights up automatically.
    kind: "single",
    id: "wildcard-trust-admin-role",
    severity: "critical",
    title: "Admin role with wildcard trust",
    predicate: (n) => has(n, "privileged") && has(n, "wildcard_trust"),
  },
  {
    kind: "single",
    id: "public-database",
    severity: "high",
    title: "Internet-reachable database",
    predicate: (n) => has(n, "publicly_accessible") && isDatabaseType(n.type),
  },
  {
    kind: "single",
    id: "privilege-escalation-identity",
    severity: "high",
    title: "Identity can escalate to admin",
    predicate: (n) => has(n, "privileged"),
  },
  {
    kind: "single",
    id: "exposed-credentials-to-privilege",
    severity: "high",
    title: "Exposed credentials on a privileged identity",
    predicate: (n) => has(n, "credential_exposure") && has(n, "privileged"),
  },
  {
    kind: "single",
    id: "public-compute-unencrypted",
    severity: "medium",
    title: "Internet-exposed host with unencrypted storage",
    predicate: (n) => has(n, "exposed_internet") && has(n, "unencrypted"),
  },
];

/* ------------------------------ graph traversal --------------------------- */

/** Undirected adjacency: each stored edge is walkable in both directions. */
function buildAdjacency(
  edges: PathEdge[],
): Map<string, { to: string; edge: PathEdge }[]> {
  const adj = new Map<string, { to: string; edge: PathEdge }[]>();
  const add = (from: string, to: string, edge: PathEdge) => {
    const list = adj.get(from) ?? [];
    list.push({ to, edge });
    adj.set(from, list);
  };
  for (const e of edges) {
    add(e.srcKey, e.dstKey, e);
    add(e.dstKey, e.srcKey, e); // undirected
  }
  return adj;
}

/** BFS from `entryKey` to the NEAREST node satisfying `isTarget` (≥1 edge,
 *  ≤ MAX_HOPS). Returns the ordered node + edge chain, or null. */
function shortestPathToTarget(
  entryKey: string,
  isTarget: (n: PathNode) => boolean,
  adj: Map<string, { to: string; edge: PathEdge }[]>,
  nodeByKey: Map<string, PathNode>,
): { nodes: string[]; edges: PathEdge[]; targetKey: string } | null {
  const queue: { key: string; nodes: string[]; edges: PathEdge[] }[] = [
    { key: entryKey, nodes: [entryKey], edges: [] },
  ];
  const visited = new Set<string>([entryKey]);

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.edges.length >= 1) {
      const node = nodeByKey.get(cur.key);
      if (node && isTarget(node)) {
        return { nodes: cur.nodes, edges: cur.edges, targetKey: cur.key };
      }
    }
    if (cur.edges.length >= MAX_HOPS) continue;
    for (const { to, edge } of adj.get(cur.key) ?? []) {
      if (visited.has(to)) continue;
      visited.add(to);
      queue.push({
        key: to,
        nodes: [...cur.nodes, to],
        edges: [...cur.edges, edge],
      });
    }
  }
  return null;
}

/* --------------------------------- engine --------------------------------- */

const SEV_RANK: Record<PathSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const CONF_RANK: Record<PathConfidence, number> = { high: 0, medium: 1, low: 2 };

function unionCapabilities(keys: string[], nodeByKey: Map<string, PathNode>): string[] {
  const set = new Set<string>();
  for (const k of keys) {
    for (const c of nodeByKey.get(k)?.capabilities ?? []) set.add(c);
  }
  return [...set];
}

/**
 * Build attack paths from a scan's graph. Deterministic; dedupes by
 * (rule_id + entry_key + target_key), ranks by severity then confidence, and
 * caps to the top {@link MAX_PATHS}.
 */
export function buildAttackPaths(
  nodes: PathNode[],
  edges: PathEdge[],
): AttackPath[] {
  const nodeByKey = new Map(nodes.map((n) => [n.nodeKey, n]));
  const adj = buildAdjacency(edges);
  const byKey = new Map<string, AttackPath>();

  const dedupeKey = (p: AttackPath) =>
    `${p.ruleId}|${p.entryKey ?? ""}|${p.targetKey ?? ""}`;
  const emit = (p: AttackPath) => {
    const k = dedupeKey(p);
    if (!byKey.has(k)) byKey.set(k, p);
  };

  for (const rule of RULES) {
    if (rule.kind === "single") {
      for (const n of nodes) {
        if (!rule.predicate(n)) continue;
        emit({
          ruleId: rule.id,
          title: `${rule.title}: ${displayName(n)}`,
          severity: rule.severity,
          entryKey: n.nodeKey,
          targetKey: n.nodeKey,
          hops: { nodes: [n.nodeKey], edges: [] },
          capabilities: [...n.capabilities],
          // Same-resource heuristic combo -> medium (no traversed edge).
          confidence: "medium",
        });
      }
    } else {
      for (const entry of nodes) {
        if (!rule.entry(entry)) continue;
        const found = shortestPathToTarget(
          entry.nodeKey,
          rule.target,
          adj,
          nodeByKey,
        );
        if (!found) continue;
        const target = nodeByKey.get(found.targetKey);
        emit({
          ruleId: rule.id,
          title: `${rule.title}: ${displayName(entry)} → ${displayName(target)}`,
          severity: rule.severity,
          entryKey: entry.nodeKey,
          targetKey: found.targetKey,
          hops: {
            nodes: found.nodes,
            edges: found.edges.map((e) => ({
              srcKey: e.srcKey,
              dstKey: e.dstKey,
              relation: e.relation,
            })),
          },
          capabilities: unionCapabilities(found.nodes, nodeByKey),
          // Used a REAL edge from the data -> high confidence.
          confidence: "high",
        });
      }
    }
  }

  const paths = [...byKey.values()];

  // Blind-spot amplifier: if the account is logging-blind, flag critical paths
  // (the attack would go unseen). Not a path of its own; raises urgency only.
  const accountLoggingBlind = nodes.some((n) => has(n, "logging_blind"));
  if (accountLoggingBlind) {
    for (const p of paths) {
      if (p.severity === "critical") {
        p.hops.blindSpot = true;
        if (!p.capabilities.includes("logging_blind")) {
          p.capabilities.push("logging_blind");
        }
      }
    }
  }

  paths.sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
      a.ruleId.localeCompare(b.ruleId) ||
      (a.entryKey ?? "").localeCompare(b.entryKey ?? ""),
  );

  return paths.slice(0, MAX_PATHS);
}

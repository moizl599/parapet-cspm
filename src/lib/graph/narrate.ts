/**
 * Grounded attack-path narration (AP-3) — SERVER-SIDE ONLY.
 *
 * Narrates COMPUTED attack paths with the local LLM, one path at a time, reusing
 * the existing structured-output pipeline (json_schema first, json_object
 * fallback, a single retry). The model only DESCRIBES the path the engine found
 * — it never invents one. Runs inside the existing background analysis job,
 * AFTER the findings analysis.
 *
 * Hard guarantees:
 *  - Grounded: the prompt contains ONLY the path's nodes/edges/capabilities, the
 *    matched rule, and the underlying finding titles. The system prompt forbids
 *    introducing anything else and requires hedging on heuristic links.
 *  - Latency-bounded: only the top {@link NARRATE_TOP_N} critical/high paths are
 *    narrated; the rest keep their computed metadata and a null narrative.
 *  - Graceful: a path whose model output is junk (even after the retry) keeps a
 *    null narrative — it never fails the job or the other paths.
 */
import "server-only";

import { streamChat as defaultStreamChat, type ChatMessage } from "@/lib/ollama";
import {
  getAttackPaths,
  getFindingsForScan,
  getGraph,
  setAttackPathNarrative,
} from "@/lib/db/repository";
import type { StreamChatFn } from "@/lib/analyze";
import type { AttackPathHops } from "@/lib/graph/paths";
import type { AttackPathRow } from "@/lib/db/schema";

/** Hard cap on narrated paths to bound CPU latency (same constraint as the main
 *  analysis). Only critical + high paths are eligible. */
export const NARRATE_TOP_N = 10;
const TEMPERATURE = 0.2;

// Narrative shape is shared with the client via the pure DTO module.
export type {
  Effort,
  BreakTheChainStep,
  PathNarrative,
} from "@/lib/attack-path-dto";
import type {
  Effort,
  BreakTheChainStep,
  PathNarrative,
} from "@/lib/attack-path-dto";

export interface NarrateOptions {
  onToken?: (token: string) => void;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

export interface NarrateDeps {
  streamChat?: StreamChatFn;
}

/* ----------------------------- structured output -------------------------- */

const NARRATIVE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    attack_scenario: { type: "string" },
    blast_radius: { type: "string" },
    severity_rationale: { type: "string" },
    break_the_chain: {
      type: "array",
      items: {
        type: "object",
        properties: {
          link: { type: "string" },
          action: { type: "string" },
          effort: {
            type: "string",
            enum: ["quick-win", "moderate", "involved"],
          },
        },
        required: ["link", "action", "effort"],
      },
    },
    confidence_note: { type: "string" },
    false_positive_risk: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: [
    "summary",
    "attack_scenario",
    "blast_radius",
    "severity_rationale",
    "break_the_chain",
    "confidence_note",
    "false_positive_risk",
  ],
} as const;

const JSON_SCHEMA_FORMAT: Record<string, unknown> = {
  type: "json_schema",
  json_schema: { name: "attack_path_narrative", schema: NARRATIVE_JSON_SCHEMA },
};
const JSON_OBJECT_FORMAT: Record<string, unknown> = { type: "json_object" };

const SYSTEM_PROMPT = `You are a senior cloud security engineer narrating ONE pre-computed AWS attack path for a small team. The path was found by a deterministic engine from real scan findings — your job is to EXPLAIN it, not to discover it.

HARD RULES (do not break these):
1. Describe ONLY the path provided in the input. NEVER introduce resources, identities, services, edges, or steps involving anything not present in the input nodes/edges. If you are tempted to add a step about something not in the input, omit it.
2. Some links are HEURISTIC. In particular "holds_data" is inferred purely from resource TYPE — the actual data sensitivity is UNKNOWN. Call this out in confidence_note and let it raise false_positive_risk. Do not assert that sensitive data is present.
3. In break_the_chain, prefer the SINGLE cheapest link to cut that breaks the WHOLE path; list it first. Each step: which node/edge to cut, a concrete remediation (console + CLI), and an effort of quick-win | moderate | involved.
4. severity_rationale must explain the severity in terms of this chain (exposure + reachability + what's at the end), not just restate a Prowler label.
5. Output ONLY a single JSON object — no markdown fences, no commentary.`;

const SCHEMA_INSTRUCTIONS = `Respond with ONLY a single JSON object matching EXACTLY this schema:
{
  "summary": string,                 // one sentence
  "attack_scenario": string,         // concrete step-by-step over THIS chain only
  "blast_radius": string,            // what the attacker reaches if successful
  "severity_rationale": string,      // why this severity for this chain
  "break_the_chain": [
    { "link": string, "action": string, "effort": "quick-win" | "moderate" | "involved" }
  ],
  "confidence_note": string,         // flag heuristic links (e.g. holds_data is type-based) + unknown data sensitivity
  "false_positive_risk": "low" | "medium" | "high"
}`;

/* -------------------------------- validation ------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function normEffort(v: unknown): Effort {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return s === "quick-win" || s === "involved" ? s : "moderate";
}
function normRisk(v: unknown): "low" | "medium" | "high" {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return s === "low" || s === "high" ? s : "medium";
}

/** Pull a JSON object out of a possibly fenced / prose-wrapped response. */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}

/**
 * Validate + coerce a model response into a PathNarrative. Returns null when the
 * response is structurally unusable (signals the caller to retry / give up) —
 * we require at least a summary and an attack scenario to be meaningful.
 */
export function parseNarrative(text: string): PathNarrative | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.summary !== "string" || parsed.summary.length === 0) return null;
  if (typeof parsed.attack_scenario !== "string") return null;

  const steps: BreakTheChainStep[] = Array.isArray(parsed.break_the_chain)
    ? parsed.break_the_chain.filter(isRecord).map((s) => ({
        link: asString(s.link),
        action: asString(s.action),
        effort: normEffort(s.effort),
      }))
    : [];

  return {
    summary: parsed.summary,
    attack_scenario: parsed.attack_scenario,
    blast_radius: asString(parsed.blast_radius),
    severity_rationale: asString(parsed.severity_rationale),
    break_the_chain: steps,
    confidence_note: asString(parsed.confidence_note),
    false_positive_risk: normRisk(parsed.false_positive_risk),
  };
}

/* -------------------------------- per path -------------------------------- */

async function collect(
  stream: AsyncIterable<string>,
  onToken?: (t: string) => void,
): Promise<string> {
  let text = "";
  for await (const token of stream) {
    text += token;
    onToken?.(token);
  }
  return text;
}

/** Build the grounded prompt input for one path (only what's in the data). */
function buildPathInput(
  row: AttackPathRow,
  nodeByKey: Map<string, { type: string; name: string | null; capabilities: string[] }>,
  titlesByResourceId: Map<string, Set<string>>,
): string {
  const hops = (row.hops as AttackPathHops | null) ?? { nodes: [], edges: [] };
  const findingTitles = new Set<string>();
  for (const key of hops.nodes) {
    const resourceId = key.slice(key.indexOf(":") + 1);
    for (const t of titlesByResourceId.get(resourceId) ?? []) findingTitles.add(t);
  }

  const input = {
    rule_id: row.ruleId,
    computed_severity: row.severity,
    computed_confidence: row.confidence,
    nodes: hops.nodes.map((key) => {
      const n = nodeByKey.get(key);
      return {
        key,
        type: n?.type ?? "unknown",
        name: n?.name ?? null,
        capabilities: n?.capabilities ?? [],
      };
    }),
    edges: hops.edges.map((e) => ({
      from: e.srcKey,
      to: e.dstKey,
      relation: e.relation,
    })),
    underlying_finding_titles: [...findingTitles],
  };

  return [
    "Narrate this single computed attack path. Use ONLY what is below.",
    "",
    JSON.stringify(input, null, 2),
    "",
    SCHEMA_INSTRUCTIONS,
  ].join("\n");
}

/**
 * Narrate one path: json_schema attempt, then a single json_object fallback.
 * Returns null (never throws) if both attempts fail — the caller leaves the
 * path's narrative null.
 */
async function narrateOnePath(
  userMessage: string,
  options: NarrateOptions,
  streamChat: StreamChatFn,
): Promise<PathNarrative | null> {
  const base: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  // Attempt 1: structured output (json_schema).
  try {
    const text = await collect(
      streamChat(base, {
        signal: options.signal,
        temperature: TEMPERATURE,
        responseFormat: JSON_SCHEMA_FORMAT,
      }),
      options.onToken,
    );
    const parsed = parseNarrative(text);
    if (parsed) return parsed;
  } catch {
    /* fall through to the fallback */
  }

  // Attempt 2 (single retry / fallback): json_object + explicit reminder.
  try {
    const retry: ChatMessage[] = [
      ...base,
      {
        role: "user",
        content:
          "Your previous reply was not valid JSON matching the schema. Reply with ONLY the JSON object — no markdown fences, no commentary.",
      },
    ];
    const text = await collect(
      streamChat(retry, {
        signal: options.signal,
        temperature: TEMPERATURE,
        responseFormat: JSON_OBJECT_FORMAT,
      }),
      options.onToken,
    );
    return parseNarrative(text);
  } catch {
    return null;
  }
}

/* --------------------------------- driver --------------------------------- */

/** Critical/high paths, top N, in the engine's ranked order. */
export function selectPathsToNarrate(rows: AttackPathRow[]): AttackPathRow[] {
  return rows
    .filter((r) => r.severity === "critical" || r.severity === "high")
    .slice(0, NARRATE_TOP_N);
}

/** How many paths a scan WOULD narrate (used by the job to size progress). */
export function plannedNarrationCount(scanId: string): number {
  return selectPathsToNarrate(getAttackPaths(scanId)).length;
}

/**
 * Narrate a scan's top attack paths and persist each narrative onto its row.
 * Best-effort per path; returns how many narratives were produced.
 */
export async function narrateAttackPaths(
  scanId: string,
  options: NarrateOptions = {},
  deps: NarrateDeps = {},
): Promise<{ narrated: number; total: number }> {
  const streamChat = deps.streamChat ?? defaultStreamChat;
  const selected = selectPathsToNarrate(getAttackPaths(scanId));

  options.onProgress?.(0, selected.length);
  if (selected.length === 0) return { narrated: 0, total: 0 };

  const graph = getGraph(scanId);
  const nodeByKey = new Map(
    graph.nodes.map((n) => [
      n.nodeKey,
      { type: n.type, name: n.name, capabilities: n.capabilities ?? [] },
    ]),
  );
  // Underlying finding titles per resource id (the bit after "type:" in a key).
  const titlesByResourceId = new Map<string, Set<string>>();
  for (const f of getFindingsForScan(scanId)) {
    const set = titlesByResourceId.get(f.resourceId) ?? new Set<string>();
    set.add(f.checkTitle);
    titlesByResourceId.set(f.resourceId, set);
  }

  let narrated = 0;
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    let narrative: PathNarrative | null = null;
    try {
      narrative = await narrateOnePath(
        buildPathInput(row, nodeByKey, titlesByResourceId),
        options,
        streamChat,
      );
    } catch {
      narrative = null; // never let one path break the rest
    }
    if (narrative) {
      try {
        setAttackPathNarrative(row.id, narrative);
        narrated += 1;
      } catch {
        /* persistence hiccup on one row must not abort the loop */
      }
    }
    options.onProgress?.(i + 1, selected.length);
  }

  return { narrated, total: selected.length };
}

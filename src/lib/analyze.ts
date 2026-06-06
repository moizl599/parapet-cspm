/**
 * LLM interpretation layer (SERVER-SIDE ONLY).
 *
 * Turns normalized FAILED findings into a prioritized, human-readable
 * remediation plan via the local Ollama model. The persona lives in the
 * verbatim system prompt; the JSON output schema is described in the user
 * message so the persona prompt stays stable.
 *
 * Robustness:
 *  - Structured outputs: each request constrains the model with
 *    `response_format: { type: "json_schema", ... }` so it emits schema-valid
 *    JSON; a single `{ type: "json_object" }` fallback is a weak last resort.
 *  - Large finding sets are grouped by service and chunked small (CHUNK_SIZE) so
 *    each prompt stays manageable; per-chunk analyses are merged + re-ranked.
 *  - RESILIENT, not all-or-nothing: each chunk gets up to MAX_CHUNK_ATTEMPTS
 *    json_schema retries (failures are usually transient). If a chunk STILL
 *    fails it is SKIPPED and the run continues — producing a PARTIAL report
 *    (`partial: true`, "N of M groups analyzed") from the chunks that
 *    succeeded. Only an all-chunks-failed run errors out.
 *  - Validation stays (a hand-rolled validator, no deps). Per-chunk timing is
 *    logged. A real caller cancellation (signal) aborts immediately, no retry.
 */

import "server-only";
import type { Finding, FindingsSummary, Severity } from "@/lib/ocsf";
import { SEVERITIES } from "@/lib/ocsf";
import { streamChat as defaultStreamChat, type ChatMessage } from "@/lib/ollama";
import { SECURITY_ENGINEER_SYSTEM_PROMPT } from "@/lib/prompts/security-engineer";

export type Effort = "quick-win" | "moderate" | "involved";

export interface AnalysisItem {
  title: string;
  severity: Severity;
  priority_rank: number;
  affected_resources: string[];
  why_it_matters: string;
  attack_scenario: string;
  remediation_steps: string[];
  effort: Effort;
  risk_of_fix: string;
  references: string[];
}

export interface Analysis {
  executive_summary: string;
  /** 0-100, higher is better posture. */
  posture_score: number;
  items: AnalysisItem[];
  quick_wins: string[];
  /**
   * True when one or more finding groups failed (after retries) and were
   * skipped — the report is built from the groups that succeeded. Re-run to
   * complete. `analyzedGroups`/`totalGroups` give the "N of M" for the UI.
   */
  partial?: boolean;
  analyzedGroups?: number;
  totalGroups?: number;
}

/** Signature compatible with `ollama.streamChat`; injectable for tests. */
export type StreamChatFn = (
  messages: ChatMessage[],
  options?: {
    signal?: AbortSignal;
    temperature?: number;
    responseFormat?: Record<string, unknown>;
  },
) => AsyncIterable<string>;

export interface AnalyzeOptions {
  /** Called for each streamed content delta, for live UI. */
  onToken?: (token: string) => void;
  /** Called after each chunk completes (and once at start with 0). */
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
  /** Override the Ollama streamer (used by tests). */
  streamChat?: StreamChatFn;
}

// Small chunks keep each prompt manageable for local instruction-following
// models (large chunks were the main cause of malformed JSON) AND generate
// faster/more reliably on CPU, lowering per-chunk failure odds. More chunks
// means more total wall-clock — see the timing logs in `analyzeFindings`.
const CHUNK_SIZE = 8;
const TEMPERATURE = 0.2;
// Per-chunk attempts with the primary json_schema format. Failures here are
// usually transient (a slow generation, an occasional off-shape reply), so we
// retry rather than failing the chunk on the first miss.
const MAX_CHUNK_ATTEMPTS = 3;
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};
const EFFORTS = new Set<Effort>(["quick-win", "moderate", "involved"]);
const SEVERITY_SET = new Set<string>(SEVERITIES);

/* -------------------------------------------------------------------------- */
/* Structured-output formats (OpenAI-compatible response_format)              */
/* -------------------------------------------------------------------------- */

const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    executive_summary: { type: "string" },
    posture_score: { type: "number" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          priority_rank: { type: "number" },
          affected_resources: { type: "array", items: { type: "string" } },
          why_it_matters: { type: "string" },
          attack_scenario: { type: "string" },
          remediation_steps: { type: "array", items: { type: "string" } },
          effort: { type: "string", enum: ["quick-win", "moderate", "involved"] },
          risk_of_fix: { type: "string" },
          references: { type: "array", items: { type: "string" } },
        },
        required: [
          "title",
          "severity",
          "priority_rank",
          "affected_resources",
          "why_it_matters",
          "attack_scenario",
          "remediation_steps",
          "effort",
          "risk_of_fix",
          "references",
        ],
      },
    },
    quick_wins: { type: "array", items: { type: "string" } },
  },
  required: ["executive_summary", "posture_score", "items", "quick_wins"],
} as const;

/** Preferred: constrain generation to the report schema. */
const JSON_SCHEMA_FORMAT: Record<string, unknown> = {
  type: "json_schema",
  json_schema: { name: "remediation_report", schema: ANALYSIS_JSON_SCHEMA },
};
/** Fallback if json_schema isn't honored: still forces syntactically valid JSON. */
const JSON_OBJECT_FORMAT: Record<string, unknown> = { type: "json_object" };

/* -------------------------------------------------------------------------- */
/* Prompt construction                                                        */
/* -------------------------------------------------------------------------- */

const SCHEMA_INSTRUCTIONS = `Respond with ONLY a single JSON object (no markdown fences, no commentary) matching EXACTLY this schema:
{
  "executive_summary": string,            // 2-5 sentences for a non-expert
  "posture_score": number,                // 0-100, higher is better
  "items": [
    {
      "title": string,
      "severity": "critical" | "high" | "medium" | "low",
      "priority_rank": number,            // 1 = do first
      "affected_resources": string[],
      "why_it_matters": string,
      "attack_scenario": string,
      "remediation_steps": string[],
      "effort": "quick-win" | "moderate" | "involved",
      "risk_of_fix": string,              // downtime/breakage to watch for
      "references": string[]
    }
  ],
  "quick_wins": string[]                  // titles or short phrases of the easiest high-value fixes
}`;

/** Truncate long free-text so a chunk's prompt stays small (faster prefill,
 *  less context pressure). */
function clip(value: string | null | undefined, max = 140): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Slim a Finding down to what the model needs (keeps token cost low). */
function slimFinding(f: Finding) {
  return {
    id: f.checkId ?? f.id,
    title: clip(f.checkTitle, 120),
    service: f.service,
    severity: f.severity,
    region: f.region,
    resource: f.resourceId,
    issue: clip(f.description),
    risk: clip(f.riskDetail),
    remediation: clip(f.remediationText),
    compliance: f.complianceFrameworks,
  };
}

function buildUserMessage(findings: Finding[], summaryLine: string): string {
  const slim = findings.map(slimFinding);
  return [
    "Analyze the following FAILED AWS security findings and produce a prioritized remediation plan.",
    "",
    summaryLine,
    "",
    SCHEMA_INSTRUCTIONS,
    "",
    "Findings (JSON):",
    JSON.stringify(slim),
  ].join("\n");
}

function describeSummary(summary: FindingsSummary, chunkCount: number): string {
  const sev = Object.entries(summary.bySeverity)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ");
  const svc = Object.entries(summary.byService)
    .map(([k, n]) => `${k}: ${n}`)
    .join(", ");
  return [
    `Scan summary — ${summary.totalFailed} failed findings total.`,
    sev ? `By severity: ${sev}.` : "",
    svc ? `By service: ${svc}.` : "",
    `(You are analyzing a batch of ${chunkCount} of these findings.)`,
  ]
    .filter(Boolean)
    .join(" ");
}

/* -------------------------------------------------------------------------- */
/* Validation (hand-rolled, no deps)                                          */
/* -------------------------------------------------------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normSeverity(v: unknown): Severity {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return (SEVERITY_SET.has(s) ? s : "medium") as Severity;
}

function normEffort(v: unknown): Effort {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return (EFFORTS.has(s as Effort) ? s : "moderate") as Effort;
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Pull the JSON object out of a model response that may be wrapped in code
 * fences or surrounded by stray prose. Returns null if no object is found.
 */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return body.slice(start, end + 1);
}

/**
 * Validate + coerce a raw model response into an Analysis. Returns null when
 * the response is structurally unusable (not JSON, or missing the core
 * `executive_summary`/`items` shape) — that signals the caller to retry. Softer
 * fields are coerced/defaulted rather than rejected.
 */
export function parseAnalysis(text: string): Analysis | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (typeof parsed.executive_summary !== "string") return null;
  if (!Array.isArray(parsed.items)) return null;

  const items: AnalysisItem[] = parsed.items
    .filter(isRecord)
    .map((raw, index) => ({
      title: asString(raw.title, "Untitled finding"),
      severity: normSeverity(raw.severity),
      priority_rank: Number.isFinite(Number(raw.priority_rank))
        ? Number(raw.priority_rank)
        : index + 1,
      affected_resources: asStringArray(raw.affected_resources),
      why_it_matters: asString(raw.why_it_matters),
      attack_scenario: asString(raw.attack_scenario),
      remediation_steps: asStringArray(raw.remediation_steps),
      effort: normEffort(raw.effort),
      risk_of_fix: asString(raw.risk_of_fix),
      references: asStringArray(raw.references),
    }));

  return {
    executive_summary: parsed.executive_summary,
    posture_score: clampScore(parsed.posture_score),
    items,
    quick_wins: asStringArray(parsed.quick_wins),
  };
}

/* -------------------------------------------------------------------------- */
/* Chunking + merge                                                           */
/* -------------------------------------------------------------------------- */

/** Group findings by service (keeping related ones together), then pack to ~40. */
export function chunkFindings(findings: Finding[]): Finding[][] {
  if (findings.length <= CHUNK_SIZE) return [findings];

  const byService = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = byService.get(f.service);
    if (bucket) bucket.push(f);
    else byService.set(f.service, [f]);
  }

  const ordered = Array.from(byService.values()).flat();
  const chunks: Finding[][] = [];
  for (let i = 0; i < ordered.length; i += CHUNK_SIZE) {
    chunks.push(ordered.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

/** Merge per-chunk analyses: concat items, re-rank, average score, dedupe wins. */
export function mergeAnalyses(parts: Analysis[]): Analysis {
  if (parts.length === 1) return parts[0];

  const items = parts
    .flatMap((p) => p.items)
    .sort((a, b) => {
      const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      return sev !== 0 ? sev : a.priority_rank - b.priority_rank;
    })
    .map((item, index) => ({ ...item, priority_rank: index + 1 }));

  const posture_score = clampScore(
    parts.reduce((sum, p) => sum + p.posture_score, 0) / parts.length,
  );
  const quick_wins = Array.from(new Set(parts.flatMap((p) => p.quick_wins)));
  const executive_summary = parts
    .map((p) => p.executive_summary)
    .join("\n\n");

  return { executive_summary, posture_score, items, quick_wins };
}

/* -------------------------------------------------------------------------- */
/* Core: stream + validate + single retry                                     */
/* -------------------------------------------------------------------------- */

async function collect(
  stream: AsyncIterable<string>,
  onToken?: (token: string) => void,
): Promise<string> {
  let text = "";
  for await (const token of stream) {
    text += token;
    onToken?.(token);
  }
  return text;
}

const isCancelled = (options: AnalyzeOptions) =>
  options.signal?.aborted === true;

async function analyzeChunk(
  findings: Finding[],
  summaryLine: string,
  options: AnalyzeOptions,
): Promise<Analysis> {
  const streamChat = options.streamChat ?? defaultStreamChat;
  const baseMessages: ChatMessage[] = [
    { role: "system", content: SECURITY_ENGINEER_SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(findings, summaryLine) },
  ];
  let lastError = "unknown error";

  // Primary path: up to MAX_CHUNK_ATTEMPTS json_schema attempts. Structured
  // output constrains the model to SCHEMA-valid JSON (grammar-enforced) — this
  // is the reliable path (plain json_object emits valid-but-wrong-SHAPE JSON on
  // local 7-8B models). Failures are usually transient (a slow generation that
  // hit the request timeout, or an occasional off-shape reply), so we retry.
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
    if (isCancelled(options)) throw new Error("Analysis was cancelled.");
    try {
      const text = await collect(
        streamChat(baseMessages, {
          signal: options.signal,
          temperature: TEMPERATURE,
          responseFormat: JSON_SCHEMA_FORMAT,
        }),
        options.onToken,
      );
      const parsed = parseAnalysis(text);
      if (parsed) return parsed;
      lastError = "model returned JSON that failed schema validation";
      console.warn(
        `[analyze] json_schema attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} failed validation; retrying.`,
      );
    } catch (err: unknown) {
      // A caller cancellation (not the internal timeout) must NOT be retried.
      if (isCancelled(options)) throw err;
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[analyze] json_schema attempt ${attempt}/${MAX_CHUNK_ATTEMPTS} errored (${lastError}); retrying.`,
      );
    }
  }

  // Last resort: a single json_object fallback with an explicit reminder. Weak
  // (often non-conforming shape) but occasionally rescues a chunk.
  if (!isCancelled(options)) {
    try {
      const retryMessages: ChatMessage[] = [
        ...baseMessages,
        {
          role: "user",
          content:
            "Your previous reply was not valid JSON matching the schema. Reply with ONLY the JSON object — no markdown fences, no commentary.",
        },
      ];
      const text = await collect(
        streamChat(retryMessages, {
          signal: options.signal,
          temperature: TEMPERATURE,
          responseFormat: JSON_OBJECT_FORMAT,
        }),
        options.onToken,
      );
      const parsed = parseAnalysis(text);
      if (parsed) return parsed;
    } catch (err: unknown) {
      if (isCancelled(options)) throw err;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(
    `Chunk analysis failed after ${MAX_CHUNK_ATTEMPTS} attempts: ${lastError}.`,
  );
}

/**
 * Analyze findings into a prioritized remediation plan. Filters to FAILED
 * findings, chunks if large, streams tokens via `onToken`, and returns the
 * merged, validated Analysis.
 */
export async function analyzeFindings(
  findings: Finding[],
  summary: FindingsSummary,
  options: AnalyzeOptions = {},
): Promise<Analysis> {
  const failed = findings.filter((f) => f.status === "fail");

  if (failed.length === 0) {
    // Nothing to remediate — skip the model entirely.
    return {
      executive_summary:
        "No failed findings were detected in this scan. Nothing requires remediation.",
      posture_score: 100,
      items: [],
      quick_wins: [],
    };
  }

  const chunks = chunkFindings(failed);
  const parts: Analysis[] = [];
  let failedChunks = 0;
  const startedAt = Date.now();
  console.log(
    `[analyze] ${failed.length} failed findings -> ${chunks.length} chunk(s) of up to ${CHUNK_SIZE}.`,
  );
  options.onProgress?.(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const summaryLine = describeSummary(summary, chunk.length);
    const chunkStart = Date.now();
    try {
      parts.push(await analyzeChunk(chunk, summaryLine, options));
      console.log(
        `[analyze] chunk ${i + 1}/${chunks.length} (${chunk.length} findings) in ` +
          `${((Date.now() - chunkStart) / 1000).toFixed(1)}s`,
      );
    } catch (err: unknown) {
      // A genuine caller cancellation aborts the whole run; otherwise SKIP this
      // chunk and keep going — a partial report beats failing everything.
      if (isCancelled(options)) throw err;
      failedChunks += 1;
      console.warn(
        `[analyze] chunk ${i + 1}/${chunks.length} SKIPPED after retries: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    options.onProgress?.(i + 1, chunks.length);
  }

  if (parts.length === 0) {
    // Nothing succeeded — this is a real failure, surface it.
    throw new Error(
      `All ${chunks.length} finding group(s) failed to analyze. Re-run to retry.`,
    );
  }

  const merged = mergeAnalyses(parts);
  if (failedChunks > 0) {
    merged.partial = true;
    merged.analyzedGroups = parts.length;
    merged.totalGroups = chunks.length;
  }
  console.log(
    `[analyze] ${merged.partial ? "PARTIAL" : "complete"}: ` +
      `${parts.length}/${chunks.length} chunk(s) ok in ` +
      `${((Date.now() - startedAt) / 1000).toFixed(1)}s total.`,
  );
  return merged;
}

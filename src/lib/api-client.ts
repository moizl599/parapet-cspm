/**
 * Client-side wrappers for the existing API (contracts unchanged). Types for
 * responses are declared here so client code never imports server modules.
 */
import type { Analysis, Finding, FindingsSummary } from "@/lib/severity";
import type { EnvironmentDto } from "@/lib/env-dto";
import type { ScanDiff, AttackPathDiff } from "@/lib/diff";
import type {
  AttackPathDto,
  AttackPathNodeDto,
  AttackPathEdgeDto,
  BreakTheChainStep,
  Effort,
  PathNarrative,
  PathsResponse,
} from "@/lib/attack-path-dto";

export type { EnvironmentDto };
export type { ScanDiff, AttackPathDiff };
export type {
  AttackPathDto,
  AttackPathNodeDto,
  AttackPathEdgeDto,
  BreakTheChainStep,
  Effort,
  PathNarrative,
  PathsResponse,
};

export type ScanStatus = "queued" | "running" | "done" | "error";
export type AnalysisStatus = "pending" | "running" | "done" | "error";

export interface ScanStatusRecord {
  scanId: string;
  status: ScanStatus;
  createdAt: string;
  updatedAt: string;
  ocsfPath?: string;
  error?: string;
  /** Analysis sub-lifecycle (decoupled background job). */
  analysisStatus?: AnalysisStatus;
  /** Per-chunk progress, e.g. "3/6". */
  analysisProgress?: string;
  analysisError?: string;
}

export interface ScanResponse {
  status: ScanStatusRecord;
  findings?: Finding[];
  summary?: FindingsSummary;
  /** Persisted analysis report once analysisStatus === "done". */
  report?: Analysis | null;
  error?: string;
}

/** POST /api/scan/[id]/reanalyze — re-run analysis on existing findings. */
export async function reanalyzeScan(scanId: string): Promise<void> {
  const res = await fetch(`/api/scan/${scanId}/reanalyze`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to re-run analysis (HTTP ${res.status}).`);
  }
}

export type HealthStatus = "ready" | "unreachable" | "model-not-found" | "error";

export interface HealthResponse {
  ok: boolean;
  status: HealthStatus;
  message: string;
  baseUrl: string;
  model: string;
}

/** GET /api/health/ollama — returns 200 (ready) or 503 (otherwise). */
export async function getOllamaHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  const res = await fetch("/api/health/ollama", { signal, cache: "no-store" });
  return (await res.json()) as HealthResponse;
}

/** POST /api/scan — triggers a scan for an environment, returns its id (202). */
export async function startScan(
  environmentId?: string,
): Promise<{ scanId: string }> {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: environmentId ? { "Content-Type": "application/json" } : undefined,
    body: environmentId ? JSON.stringify({ environmentId }) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to start scan (HTTP ${res.status}).`);
  }
  return (await res.json()) as { scanId: string };
}

/* ------------------------------- environments ------------------------------ */

export interface EnvironmentInput {
  name: string;
  authMode: "role" | "base";
  targetAccountId?: string | null;
  roleArn?: string | null;
  externalId?: string;
  regions?: string[];
}

export interface TestConnectionResult {
  ok: boolean;
  account_id?: string;
  error?: string;
}

export async function listEnvironments(
  signal?: AbortSignal,
): Promise<EnvironmentDto[]> {
  const res = await fetch("/api/environments", { signal, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load environments (HTTP ${res.status}).`);
  }
  return ((await res.json()) as { environments: EnvironmentDto[] }).environments;
}

export async function createEnvironment(
  input: EnvironmentInput,
): Promise<EnvironmentDto> {
  const res = await fetch("/api/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as {
    environment?: EnvironmentDto;
    error?: string;
  };
  if (!res.ok || !body.environment) {
    throw new Error(body.error ?? `Failed to create environment (HTTP ${res.status}).`);
  }
  return body.environment;
}

export async function updateEnvironment(
  id: string,
  input: EnvironmentInput,
): Promise<EnvironmentDto> {
  const res = await fetch(`/api/environments/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as {
    environment?: EnvironmentDto;
    error?: string;
  };
  if (!res.ok || !body.environment) {
    throw new Error(body.error ?? `Failed to update environment (HTTP ${res.status}).`);
  }
  return body.environment;
}

export async function deleteEnvironment(id: string): Promise<void> {
  const res = await fetch(`/api/environments/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to delete environment (HTTP ${res.status}).`);
  }
}

/** POST /api/environments/test — verify the base identity can assume a role. */
export async function testConnection(
  roleArn: string,
  externalId: string,
): Promise<TestConnectionResult> {
  const res = await fetch("/api/environments/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_arn: roleArn, external_id: externalId }),
  });
  return (await res.json()) as TestConnectionResult;
}

/* ----------------------------- history & diff ----------------------------- */

export interface ScanHistoryItem {
  id: string;
  status: ScanStatus;
  analysisStatus: AnalysisStatus;
  startedAt: string | null;
  finishedAt: string | null;
  postureScore: number | null;
  failedCount: number | null;
}

export interface ScanRef {
  scanId: string;
  startedAt: string | null;
  postureScore: number | null;
}

export interface ScanDiffResult {
  /** null when there is no prior scan to compare against. */
  diff: ScanDiff | null;
  /** Attack-path deltas (new / resolved / unchanged); null when no prior scan. */
  pathDiff: AttackPathDiff | null;
  before: ScanRef | null;
  after: ScanRef;
}

/** GET /api/environments/[id]/scans — scan history, newest first. */
export async function getScanHistory(
  environmentId: string,
  signal?: AbortSignal,
): Promise<ScanHistoryItem[]> {
  const res = await fetch(`/api/environments/${environmentId}/scans`, {
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load scan history (HTTP ${res.status}).`);
  }
  return ((await res.json()) as { scans: ScanHistoryItem[] }).scans;
}

/**
 * GET /api/scans/[id]/diff — diff a scan against another (or, by default, the
 * previous completed scan). `diff` is null when there's no prior scan.
 */
export async function getScanDiff(
  scanId: string,
  against?: string,
  signal?: AbortSignal,
): Promise<ScanDiffResult> {
  const url = against
    ? `/api/scans/${scanId}/diff?against=${encodeURIComponent(against)}`
    : `/api/scans/${scanId}/diff`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load diff (HTTP ${res.status}).`);
  }
  return (await res.json()) as ScanDiffResult;
}

/** GET /api/scan/[id]/paths — computed attack paths (+ narrative where present). */
export async function getScanPaths(
  scanId: string,
  signal?: AbortSignal,
): Promise<PathsResponse> {
  const res = await fetch(`/api/scan/${scanId}/paths`, {
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load attack paths (HTTP ${res.status}).`);
  }
  return (await res.json()) as PathsResponse;
}

/** GET /api/scan/[id] — status, plus findings + summary when done. */
export async function getScan(
  scanId: string,
  signal?: AbortSignal,
): Promise<ScanResponse> {
  const res = await fetch(`/api/scan/${scanId}`, { signal, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to load scan (HTTP ${res.status}).`);
  }
  return (await res.json()) as ScanResponse;
}

export interface AnalysisStreamHandlers {
  onToken?: (value: string) => void;
  onProgress?: (completed: number, total: number) => void;
  onResult?: (analysis: Analysis) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

/**
 * POST /api/analyze/[id] and consume its SSE stream. EventSource only supports
 * GET, so we read the response body and parse `event:`/`data:` frames manually.
 * Resolves when the stream ends (the `done` event or the body closing).
 */
export async function streamAnalysis(
  scanId: string,
  handlers: AnalysisStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/analyze/${scanId}`, { method: "POST", signal });

  if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    handlers.onError?.(body.error ?? `Analysis failed (HTTP ${res.status}).`);
    handlers.onDone?.();
    return;
  }
  if (!res.body) {
    handlers.onError?.("Analysis stream returned no body.");
    handlers.onDone?.();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    const data = payload as {
      value?: string;
      completed?: number;
      total?: number;
      analysis?: Analysis;
      error?: string;
    };
    if (event === "token" && typeof data.value === "string") {
      handlers.onToken?.(data.value);
    } else if (event === "progress" && typeof data.completed === "number") {
      handlers.onProgress?.(data.completed, data.total ?? 0);
    } else if (event === "result" && data.analysis) {
      handlers.onResult?.(data.analysis);
    } else if (event === "error") {
      handlers.onError?.(data.error ?? "Analysis failed.");
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.trim()) dispatch(frame);
      }
    }
  } finally {
    reader.releaseLock();
    handlers.onDone?.();
  }
}

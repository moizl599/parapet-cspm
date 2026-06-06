/**
 * Ollama client (SERVER-SIDE ONLY).
 *
 * Talks to Ollama's OpenAI-compatible Chat Completions endpoint using native
 * `fetch` only — no OpenAI SDK. Base URL comes from config (default
 * http://localhost:11434/v1). Ollama ignores the API key, but the OpenAI-compat
 * layer expects an Authorization header, so we send the conventional
 * `Bearer ollama`.
 *
 * Uses `fetch` + the Web Streams API, both available in the Node.js runtime —
 * mark routes that import this with `export const runtime = "nodejs"`.
 */

import "server-only";
// Use undici's own fetch/Response so our undici Agent dispatcher is accepted
// (Node's built-in fetch rejects a dispatcher from a different undici instance).
import { Agent, fetch, Response } from "undici";
import { getOllamaConfig } from "@/lib/config";

const AUTHORIZATION = "Bearer ollama";
// Per-request cap. CPU generations are slow — we've observed valid chunks take
// up to ~17 min, and the old 20-min cap was aborting healthy json_schema chunks
// mid-generation (the root cause of intermittent analysis failures). 40 min
// gives generous headroom so a real generation is never killed prematurely;
// per-chunk retries + partial results (see analyze.ts) handle anything slower.
const DEFAULT_TIMEOUT_MS = 2_400_000; // 40 min
const HEALTHCHECK_TIMEOUT_MS = 5_000;

/**
 * Dispatcher for Ollama generation calls. undici's default `headersTimeout`/
 * `bodyTimeout` (5 min each) abort long CPU generations before the first token
 * arrives (large prompts can take minutes to prefill). Disable both and rely on
 * our own AbortSignal (DEFAULT_TIMEOUT_MS) as the cap.
 */
const OLLAMA_DISPATCHER = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connect: { timeout: 15_000 },
});

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  /** Sampling temperature; default low for deterministic, schema-faithful JSON. */
  temperature?: number;
  /**
   * OpenAI-compatible `response_format` to constrain output, e.g.
   * `{ type: "json_schema", json_schema: {...} }` or `{ type: "json_object" }`.
   * Passed through verbatim; Ollama maps it to its native structured outputs.
   */
  responseFormat?: Record<string, unknown>;
}

export type OllamaHealthStatus =
  | "ready"
  | "unreachable"
  | "model-not-found"
  | "error";

export interface OllamaHealth {
  ok: boolean;
  status: OllamaHealthStatus;
  /** Human-friendly, actionable message. */
  message: string;
  baseUrl: string;
  model: string;
}

interface ChatRequestInit {
  messages: ChatMessage[];
  stream: boolean;
  temperature: number;
  signal?: AbortSignal;
  timeoutMs: number;
  responseFormat?: Record<string, unknown>;
}

/**
 * Combine an optional caller signal with an internal timeout so requests never
 * hang forever but still honor client cancellation.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function postChat(init: ChatRequestInit): Promise<Response> {
  const { baseUrl, model } = getOllamaConfig();
  const body: Record<string, unknown> = {
    model,
    messages: init.messages,
    stream: init.stream,
    temperature: init.temperature,
  };
  if (init.responseFormat) body.response_format = init.responseFormat;
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTHORIZATION,
    },
    body: JSON.stringify(body),
    signal: withTimeout(init.signal, init.timeoutMs),
    dispatcher: OLLAMA_DISPATCHER,
  });
}

/** True when an HTTP error body / status indicates the model isn't pulled. */
function looksLikeModelNotFound(status: number, bodyText: string): boolean {
  if (status === 404) return true;
  return /not found|no such model|try pulling|failed to load model/i.test(
    bodyText,
  );
}

/**
 * Stream a chat completion, yielding content deltas as they arrive. Parses the
 * OpenAI-style SSE stream (`data: {json}` lines, terminated by `data: [DONE]`).
 *
 * @throws if the request fails or the model is unavailable.
 */
export async function* streamChat(
  messages: ChatMessage[],
  options: ChatOptions = {},
): AsyncGenerator<string> {
  const response = await postChat({
    messages,
    stream: true,
    temperature: options.temperature ?? 0.2,
    signal: options.signal,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    responseFormat: options.responseFormat,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const { model } = getOllamaConfig();
    if (looksLikeModelNotFound(response.status, text)) {
      throw new Error(
        `Ollama model "${model}" is not available. Pull it with: ollama pull ${model}`,
      );
    }
    throw new Error(
      `Ollama request failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!response.body) throw new Error("Ollama returned an empty response body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) continue; // skip keep-alives / blanks

        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: unknown } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
        } catch {
          // Partial JSON across chunk boundaries is normal — ignore and continue.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Tolerate the ":latest" tag being omitted on either side when matching. */
function modelMatches(id: string, model: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`);
  return id === model || norm(id) === norm(model);
}

/**
 * Check Ollama readiness by listing installed models (fast, no inference).
 * Distinguishes the two failure modes the user cares about: Ollama not running
 * (connection refused / timeout -> "unreachable") vs. the configured model not
 * being pulled ("model-not-found"). Deliberately avoids triggering a generation
 * so a slow first-token model load isn't misreported as unreachable.
 */
export async function healthCheck(): Promise<OllamaHealth> {
  const { baseUrl, model } = getOllamaConfig();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: AUTHORIZATION },
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    // fetch throws on connection refused / DNS / timeout -> Ollama unreachable.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: "unreachable",
      message: `Cannot reach Ollama at ${baseUrl}. Is it running? (ollama serve, or start the Docker service). Details: ${reason}`,
      baseUrl,
      model,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: "error",
      message: `Ollama responded with HTTP ${response.status}: ${text.slice(0, 200)}`,
      baseUrl,
      model,
    };
  }

  let ids: string[] = [];
  try {
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    ids = Array.isArray(body.data)
      ? body.data
          .map((m) => (typeof m.id === "string" ? m.id : ""))
          .filter(Boolean)
      : [];
  } catch {
    // Unparseable list body — treat as an error rather than guessing.
    return {
      ok: false,
      status: "error",
      message: `Ollama is reachable at ${baseUrl} but returned an unreadable model list.`,
      baseUrl,
      model,
    };
  }

  if (ids.some((id) => modelMatches(id, model))) {
    return {
      ok: true,
      status: "ready",
      message: `Ollama is reachable at ${baseUrl} and model "${model}" is available.`,
      baseUrl,
      model,
    };
  }

  return {
    ok: false,
    status: "model-not-found",
    message: `Ollama is running, but model "${model}" is not pulled. Run: ollama pull ${model}. Installed: ${ids.join(", ") || "none"}`,
    baseUrl,
    model,
  };
}

"use client";

/**
 * Ollama readiness UI. Degraded states are friendly and actionable — and worded
 * DIFFERENTLY for "unreachable" (service down) vs "model-not-found" (service up,
 * model missing). Never a crash.
 */
import { AlertTriangleIcon, CheckCircleIcon, PlugIcon } from "@/components/icons";
import { Button, CopyButton } from "@/components/ui/primitives";
import type { HealthResponse } from "@/lib/api-client";

/** Compact status dot for the header. */
export function HealthChip({ health }: { health: HealthResponse | null }) {
  const ready = health?.ok ?? false;
  const label = !health
    ? "Checking LLM…"
    : ready
      ? "LLM ready"
      : health.status === "model-not-found"
        ? "Model not pulled"
        : health.status === "unreachable"
          ? "LLM unreachable"
          : "LLM error";
  const color = !health
    ? "bg-faint"
    : ready
      ? "bg-ok"
      : health.status === "unreachable"
        ? "bg-critical"
        : "bg-high";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1 text-xs font-medium text-muted"
      title={health?.message}
    >
      <span className={`size-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}

export function OllamaHealthBanner({
  health,
  onRetry,
  retrying = false,
}: {
  health: HealthResponse | null;
  onRetry: () => void;
  retrying?: boolean;
}) {
  // Hidden while unknown or healthy — only surfaces problems.
  if (!health || health.ok) return null;

  const model = health.model;
  const copy =
    health.status === "model-not-found"
      ? {
          title: "Local model not pulled yet",
          body: `Ollama is running, but the “${model}” model hasn’t been downloaded. Pull it once — scans still work in the meantime; AI analysis resumes automatically after.`,
          command: `docker compose exec ollama ollama pull ${model}`,
        }
      : health.status === "unreachable"
        ? {
            title: "Ollama is unreachable",
            body: `The local LLM service isn’t responding at ${health.baseUrl}. Start it (ollama serve, or docker compose up -d ollama). You can still run scans and review raw findings — AI analysis is paused until it’s back.`,
            command: "docker compose up -d ollama",
          }
        : {
            title: "Ollama returned an error",
            body: health.message,
            command: null,
          };

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-rise flex flex-col gap-3 rounded-xl border border-high/30 bg-high/8 px-5 py-4 sm:flex-row sm:items-start"
    >
      <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-high" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">{copy.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{copy.body}</p>
        {copy.command && (
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-xs text-fg">
              {copy.command}
            </code>
            <CopyButton value={copy.command} label="Copy command" />
          </div>
        )}
      </div>
      <Button
        variant="secondary"
        onClick={onRetry}
        loading={retrying}
        className="shrink-0"
        icon={<PlugIcon className="size-4" />}
      >
        Re-check
      </Button>
    </div>
  );
}

/** Inline ready confirmation (used on overview when healthy). */
export function HealthReady({ health }: { health: HealthResponse | null }) {
  if (!health?.ok) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <CheckCircleIcon className="size-3.5 text-ok" />
      {health.model} ready
    </span>
  );
}

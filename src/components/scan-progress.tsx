"use client";

/**
 * Long-running scan + analysis progress. The analysis can take ~an hour on CPU,
 * so this is built to reassure: a real-lifecycle stepper (Queued -> Scanning AWS
 * -> Analyzing chunk N/M -> Done), a ticking elapsed clock, a SOFT remaining-time
 * estimate (clearly labelled, never a promise), a determinate bar during
 * analysis, and an explicit "safe to close this tab" message. On error /
 * interruption it offers a re-run that reuses findings (no rescan). An optional
 * "watch it think" toggle attaches to the live token stream — closing it never
 * affects the background job.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  LoaderIcon,
  XIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/primitives";

export type ProgressStage =
  | "queued"
  | "scanning"
  | "analyzing"
  | "done"
  | "scan-error"
  | "analysis-error";

const STEPS = [
  { key: "queued", label: "Queued" },
  { key: "scanning", label: "Scanning AWS" },
  { key: "analyzing", label: "Analyzing findings" },
  { key: "done", label: "Complete" },
] as const;

function stageIndex(stage: ProgressStage): number {
  switch (stage) {
    case "queued":
      return 0;
    case "scanning":
    case "scan-error":
      return 1;
    case "analyzing":
    case "analysis-error":
      return 2;
    case "done":
      return 3;
  }
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m === 0 ? `${sec}s` : `${m}m ${sec.toString().padStart(2, "0")}s`;
}

function fmtEta(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "under a minute";
  if (min === 1) return "about a minute";
  return `about ${min} min`;
}

export interface ScanProgressProps {
  stage: ProgressStage;
  /** Per-chunk analysis progress parsed from the DB ("3/6"). */
  chunk?: { completed: number; total: number } | null;
  /** Epoch ms the run started (for the elapsed clock). */
  startedAt?: number | null;
  /** Epoch ms the analysis stage began (basis for the ETA estimate). */
  analysisStartedAt?: number | null;
  scanError?: string | null;
  analysisError?: string | null;
  /** Re-run analysis on existing findings (no rescan). */
  onRerunAnalysis?: () => void;
  rerunning?: boolean;
  /** Re-run the whole scan. */
  onRerunScan?: () => void;
  /** Optional "watch it think" live stream controls. */
  live?: {
    active: boolean;
    onToggle: () => void;
    node: ReactNode;
  };
}

export function ScanProgress({
  stage,
  chunk,
  startedAt,
  analysisStartedAt,
  scanError,
  analysisError,
  onRerunAnalysis,
  rerunning = false,
  onRerunScan,
  live,
}: ScanProgressProps) {
  const active = stage === "queued" || stage === "scanning" || stage === "analyzing";

  // Self-contained 1s ticker — only runs while the job is active.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!active) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    /* eslint-enable react-hooks/set-state-in-effect */
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  const current = stageIndex(stage);
  const errored = stage === "scan-error" || stage === "analysis-error";

  const elapsed = startedAt && now ? now - startedAt : null;

  // Soft ETA: average per-chunk time so far × chunks remaining. Only once at
  // least one chunk is done so the average is meaningful.
  let eta: string | null = null;
  let barPct: number | null = null;
  if (chunk && chunk.total > 0) {
    barPct = Math.min(100, Math.round((chunk.completed / chunk.total) * 100));
    if (
      stage === "analyzing" &&
      analysisStartedAt &&
      now &&
      chunk.completed >= 1 &&
      chunk.completed < chunk.total
    ) {
      const perChunk = (now - analysisStartedAt) / chunk.completed;
      eta = fmtEta(perChunk * (chunk.total - chunk.completed));
    }
  }

  return (
    <div className="animate-rise flex flex-col gap-4">
      {/* Stepper */}
      <ol className="flex items-center">
        {STEPS.map((step, i) => {
          const done = !errored && i < current;
          const isCurrent = !errored && i === current;
          const isErrStep = errored && i === current;
          return (
            <li key={step.key} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-300",
                    done
                      ? "border-ok/40 bg-ok/15 text-ok"
                      : isErrStep
                        ? "border-critical/40 bg-critical/15 text-critical"
                        : isCurrent
                          ? "border-primary/50 bg-primary/15 text-primary-hi"
                          : "border-border bg-surface-2 text-faint",
                  ].join(" ")}
                >
                  {done ? (
                    <CheckIcon className="size-4" />
                  ) : isErrStep ? (
                    <AlertTriangleIcon className="size-4" />
                  ) : isCurrent ? (
                    <LoaderIcon className="size-4 animate-spin" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={[
                    "hidden text-sm font-medium transition-colors duration-300 sm:inline",
                    done || isCurrent
                      ? "text-fg"
                      : isErrStep
                        ? "text-critical"
                        : "text-faint",
                  ].join(" ")}
                >
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <span
                  className={`mx-3 h-px flex-1 transition-colors duration-300 ${
                    done ? "bg-ok/40" : "bg-border"
                  }`}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>

      {/* Live status line */}
      {active && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-sm font-medium text-fg">
              {stage === "queued" && "Queued — waiting for a runner…"}
              {stage === "scanning" &&
                "Scanning your AWS account with Prowler (read-only)…"}
              {stage === "analyzing" &&
                (chunk
                  ? `Analyzing findings — chunk ${chunk.completed} of ${chunk.total}`
                  : "Preparing analysis…")}
            </p>
            {elapsed != null && (
              <span className="tnum text-xs text-muted">
                {fmtDuration(elapsed)} elapsed
                {eta && (
                  <>
                    {" · "}
                    <span className="text-faint">{eta} remaining (estimate)</span>
                  </>
                )}
              </span>
            )}
          </div>

          {/* Progress bar: determinate during analysis, indeterminate otherwise */}
          {stage === "analyzing" && barPct != null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-valuenow={barPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Analysis progress"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                style={{ width: `${barPct}%` }}
              />
            </div>
          ) : (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label={`${stage} in progress`}
            >
              <div className="h-full w-1/3 animate-[indeterminate_1.3s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
          )}

          {/* Reassurance: safe to leave */}
          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
            <p className="text-xs leading-relaxed text-muted">
              Analysis runs in the background on the server.{" "}
              <span className="font-medium text-fg">
                It&apos;s safe to close this tab
              </span>{" "}
              — come back any time and progress will be right where you left it.
            </p>
          </div>

          {/* Optional live stream toggle */}
          {stage === "analyzing" && live && (
            <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={live.onToggle}
                aria-expanded={live.active}
                className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md text-xs font-medium text-primary-hi transition-colors hover:text-fg"
              >
                {live.active ? (
                  <>
                    <XIcon className="size-3.5" />
                    Hide live output
                  </>
                ) : (
                  <>
                    <span className="size-2 animate-pulse rounded-full bg-primary-hi" />
                    Watch it think
                  </>
                )}
              </button>
              {live.active && live.node}
            </div>
          )}
        </div>
      )}

      {/* Scan failed — fatal, needs a rescan */}
      {stage === "scan-error" && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-critical/30 bg-critical/8 px-4 py-3"
        >
          <p className="text-sm font-semibold text-fg">The scan failed</p>
          <p className="text-sm leading-relaxed text-muted">
            {scanError ?? "Prowler could not complete the scan."}
          </p>
          {onRerunScan && (
            <Button variant="secondary" onClick={onRerunScan} className="w-fit">
              Re-run scan
            </Button>
          )}
        </div>
      )}

      {/* Analysis failed / interrupted — findings are intact, reuse them */}
      {stage === "analysis-error" && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-high/30 bg-high/8 px-4 py-3"
        >
          <p className="text-sm font-semibold text-fg">
            Analysis didn&apos;t finish
          </p>
          <p className="text-sm leading-relaxed text-muted">
            {analysisError ??
              "The analysis was interrupted before it completed."}{" "}
            Your scan findings are saved — re-running reuses them, so there&apos;s
            no need to rescan AWS.
          </p>
          {onRerunAnalysis && (
            <Button
              variant="secondary"
              onClick={onRerunAnalysis}
              loading={rerunning}
              className="w-fit"
            >
              Re-run analysis
            </Button>
          )}
        </div>
      )}

      <style>{`@keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
    </div>
  );
}

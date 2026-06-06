"use client";

/**
 * Live scan pipeline status: queued -> scanning -> analyzing -> done (or error).
 * Shows a 4-step tracker plus an indeterminate progress bar while a stage runs.
 */
import { CheckIcon, LoaderIcon, AlertTriangleIcon } from "@/components/icons";

export type PipelineStage =
  | "idle"
  | "queued"
  | "scanning"
  | "analyzing"
  | "done"
  | "error";

const STEPS = [
  { key: "queued", label: "Queued" },
  { key: "scanning", label: "Scanning AWS" },
  { key: "analyzing", label: "Analyzing" },
  { key: "done", label: "Complete" },
] as const;

function stageIndex(stage: PipelineStage): number {
  switch (stage) {
    case "queued":
      return 0;
    case "scanning":
      return 1;
    case "analyzing":
      return 2;
    case "done":
      return 3;
    default:
      return -1;
  }
}

export function PipelineStatus({
  stage,
  error,
}: {
  stage: PipelineStage;
  error?: string | null;
}) {
  if (stage === "idle") return null;
  const current = stageIndex(stage);
  const isError = stage === "error";
  const active = !isError && stage !== "done";

  return (
    <div className="animate-rise flex flex-col gap-3">
      <ol className="flex items-center">
        {STEPS.map((step, i) => {
          const done = !isError && i < current;
          const isCurrent = !isError && i === current;
          const errored = isError && i === Math.max(0, current);
          return (
            <li key={step.key} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-300",
                    done
                      ? "border-ok/40 bg-ok/15 text-ok"
                      : errored
                        ? "border-critical/40 bg-critical/15 text-critical"
                        : isCurrent
                          ? "border-primary/50 bg-primary/15 text-primary-hi"
                          : "border-border bg-surface-2 text-faint",
                  ].join(" ")}
                >
                  {done ? (
                    <CheckIcon className="size-4" />
                  ) : errored ? (
                    <AlertTriangleIcon className="size-4" />
                  ) : isCurrent ? (
                    <LoaderIcon className="size-4 animate-spin" />
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={[
                    "text-sm font-medium transition-colors duration-300",
                    done || isCurrent
                      ? "text-fg"
                      : errored
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

      {active && (
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-surface-3"
          role="progressbar"
          aria-label={`${stage} in progress`}
        >
          <div className="h-full w-1/3 animate-[indeterminate_1.3s_ease-in-out_infinite] rounded-full bg-primary" />
        </div>
      )}

      {isError && error && (
        <p className="text-sm text-critical" role="alert">
          {error}
        </p>
      )}

      <style>{`@keyframes indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
    </div>
  );
}

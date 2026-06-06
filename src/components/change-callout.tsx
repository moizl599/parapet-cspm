"use client";

/**
 * Overview banner summarizing what changed since the previous completed scan:
 * "+3 new, 5 resolved, posture +11". Links to the full diff view. Only rendered
 * when a prior completed scan exists (the parent passes a non-null diff).
 */
import { SortIcon } from "@/components/icons";
import { Button } from "@/components/ui/primitives";
import { signed } from "@/lib/format";
import type { ScanDiffResult } from "@/lib/api-client";

export function ChangeCallout({
  result,
  onView,
}: {
  result: ScanDiffResult;
  onView: () => void;
}) {
  const diff = result.diff;
  if (!diff) return null;

  const introduced = diff.introduced.length;
  const resolved = diff.resolved.length;
  const delta = diff.postureDelta.delta;

  // Tone the banner by net direction: regression (new>resolved or posture down)
  // leans amber, improvement leans green, otherwise neutral.
  const regressed =
    (delta != null && delta < 0) || introduced > resolved;
  const improved =
    !regressed && (resolved > 0 || (delta != null && delta > 0));
  const accent = regressed
    ? "border-high/30 bg-high/8"
    : improved
      ? "border-ok/30 bg-ok/8"
      : "border-border bg-surface-2/50";

  return (
    <div
      className={`animate-rise flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-5 py-3.5 ${accent}`}
    >
      <span className="text-sm font-medium text-fg">Since your last scan</span>
      <div className="flex items-center gap-4 text-sm">
        <span className="text-muted">
          <span className="tnum font-semibold text-critical">{signed(introduced)}</span>{" "}
          new
        </span>
        <span className="text-muted">
          <span className="tnum font-semibold text-ok">{resolved}</span> resolved
        </span>
        {delta != null && (
          <span className="text-muted">
            posture{" "}
            <span
              className={`tnum font-semibold ${
                delta > 0 ? "text-ok" : delta < 0 ? "text-critical" : "text-muted"
              }`}
            >
              {signed(delta)}
            </span>
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        onClick={onView}
        icon={<SortIcon className="size-4" />}
        className="ml-auto"
      >
        View changes
      </Button>
    </div>
  );
}

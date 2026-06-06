"use client";

import type { ReactNode } from "react";
import { AlertTriangleIcon } from "@/components/icons";
import { Button, Skeleton } from "@/components/ui/primitives";

/**
 * Soft "partial report" note — shown ABOVE a rendered report (not instead of it)
 * when some finding groups failed and were skipped. The report is still useful;
 * re-running reuses the findings to fill in the gaps.
 */
export function PartialReportNote({
  analyzed,
  total,
  onRerun,
  rerunning = false,
}: {
  analyzed?: number;
  total?: number;
  onRerun?: () => void;
  rerunning?: boolean;
}) {
  const counts = analyzed != null && total != null ? `${analyzed} of ${total}` : "some";
  return (
    <div
      role="status"
      className="animate-rise flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-medium/30 bg-medium/8 px-4 py-2.5"
    >
      <AlertTriangleIcon className="size-4 shrink-0 text-medium" />
      <p className="text-sm text-muted">
        <span className="font-medium text-fg">Partial report</span> — analyzed{" "}
        {counts} finding groups. Re-run to complete.
      </p>
      {onRerun && (
        <Button
          variant="secondary"
          onClick={onRerun}
          loading={rerunning}
          className="ml-auto px-3 py-1.5 text-xs"
        >
          Re-run analysis
        </Button>
      )}
    </div>
  );
}

/** Empty state — no scan run yet (or no data for a view). */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-2 text-2xl text-faint">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/** Error state with a retry affordance. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-critical/30 bg-critical/8 px-6 py-12 text-center"
    >
      <AlertTriangleIcon className="mb-3 size-8 text-critical" />
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">
        {message}
      </p>
      {onRetry ? (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Card-shaped loading skeleton used while a scan/analysis is in flight. */
export function PanelSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface/80 p-5">
      <Skeleton className="h-4 w-32" />
      <div className="mt-4 flex flex-col gap-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={`h-3 ${i % 2 ? "w-3/4" : "w-full"}`} />
        ))}
      </div>
    </div>
  );
}

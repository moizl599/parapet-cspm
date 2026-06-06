"use client";

/**
 * Scan history for the selected environment: a posture trend sparkline over the
 * completed scans, plus a table of every scan (time, status, posture, failed
 * count). Clicking a completed scan opens its full report (the dashboard reuses
 * its normal rendering against that historical scan id).
 */
import { PostureSparkline } from "@/components/charts";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  GaugeIcon,
  ListIcon,
  LoaderIcon,
} from "@/components/icons";
import { Card, CardHeader, Skeleton } from "@/components/ui/primitives";
import { EmptyState, ErrorState } from "@/components/states";
import { postureBand } from "@/lib/posture";
import { formatDateTime } from "@/lib/format";
import type { ScanHistoryItem } from "@/lib/api-client";

function StatusPill({ item }: { item: ScanHistoryItem }) {
  if (item.status === "error")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-critical">
        <AlertTriangleIcon className="size-3.5" /> Scan failed
      </span>
    );
  if (item.status !== "done")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
        <LoaderIcon className="size-3.5 animate-spin" /> Scanning
      </span>
    );
  // scan done — reflect analysis sub-state
  if (item.analysisStatus === "done")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ok">
        <CheckCircleIcon className="size-3.5" /> Complete
      </span>
    );
  if (item.analysisStatus === "error")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-high">
        <AlertTriangleIcon className="size-3.5" /> Analysis failed
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
      <LoaderIcon className="size-3.5 animate-spin" /> Analyzing
    </span>
  );
}

export function ScanHistory({
  items,
  error,
  currentScanId,
  onOpenScan,
  onRetry,
}: {
  items: ScanHistoryItem[] | null;
  error: string | null;
  currentScanId: string | null;
  onOpenScan: (scanId: string) => void;
  onRetry: () => void;
}) {
  if (error) {
    return <ErrorState title="Couldn’t load scan history" message={error} onRetry={onRetry} />;
  }

  if (items === null) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-14 w-full" />
        </Card>
        <Card className="p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-32 w-full" />
        </Card>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ListIcon className="size-6" />}
        title="No scans yet"
        description="Run a scan for this environment. Each scan is kept here so you can track your posture over time and compare what changed."
      />
    );
  }

  // Sparkline from completed scans with a posture score, oldest → newest.
  const trend = items
    .filter((s) => s.status === "done" && s.postureScore != null)
    .slice()
    .reverse()
    .map((s) => ({ score: s.postureScore as number }));

  return (
    <div className="flex flex-col gap-4">
      {trend.length >= 2 && (
        <Card>
          <CardHeader title="Posture trend" icon={<GaugeIcon className="size-4" />} />
          <div className="px-5 py-4">
            <PostureSparkline points={trend} />
            <div className="mt-1 flex items-center justify-between text-[11px] text-faint">
              <span>{trend.length} completed scans</span>
              <span>higher is better</span>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Scan history" icon={<ListIcon className="size-4" />} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-faint">
                <th className="px-5 py-2.5 font-medium">When</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 text-right font-medium">Posture</th>
                <th className="px-5 py-2.5 text-right font-medium">Failed</th>
                <th className="px-5 py-2.5" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const band = postureBand(s.postureScore);
                const openable = s.status === "done";
                const isCurrent = s.id === currentScanId;
                return (
                  <tr
                    key={s.id}
                    className={`border-b border-border/60 last:border-0 ${
                      isCurrent ? "bg-surface-2/50" : ""
                    }`}
                  >
                    <td className="px-5 py-3 text-muted">
                      {formatDateTime(s.startedAt)}
                      {isCurrent && (
                        <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary-hi">
                          viewing
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <StatusPill item={s} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      {s.postureScore != null ? (
                        <span className={`tnum font-semibold ${band.className}`}>
                          {s.postureScore}
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="tnum px-5 py-3 text-right text-muted">
                      {s.failedCount ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {openable && (
                        <button
                          type="button"
                          onClick={() => onOpenScan(s.id)}
                          className="cursor-pointer rounded-md px-2 py-1 text-xs font-medium text-primary-hi transition-colors hover:bg-surface-2 hover:text-fg"
                        >
                          Open report →
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

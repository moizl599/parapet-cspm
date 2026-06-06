"use client";

/**
 * Scan diff: latest completed scan vs the previous by default, with a picker for
 * any two completed scans. Shows the posture delta prominently and three groups
 * — New issues / Resolved / Still open — each with counts and severity badges.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ListIcon,
  PlusIcon,
  RouteIcon,
} from "@/components/icons";
import { Card, CardHeader, SeverityBadge, Skeleton } from "@/components/ui/primitives";
import { EmptyState, ErrorState } from "@/components/states";
import { formatDateTime, signed } from "@/lib/format";
import {
  getScanDiff,
  type ScanDiffResult,
  type ScanHistoryItem,
} from "@/lib/api-client";
import type { Finding } from "@/lib/severity";
import type { AttackPathRef } from "@/lib/diff";

export function ScanDiff({ completed }: { completed: ScanHistoryItem[] }) {
  const hasPair = completed.length >= 2;
  const [afterId, setAfterId] = useState<string>(completed[0]?.id ?? "");
  const [beforeId, setBeforeId] = useState<string>(completed[1]?.id ?? "");
  const [result, setResult] = useState<ScanDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (after: string, before: string) => {
    if (!after || !before) return;
    const myReq = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await getScanDiff(after, before);
      if (reqId.current === myReq) setResult(res);
    } catch (e) {
      if (reqId.current === myReq)
        setError(e instanceof Error ? e.message : "Failed to load the diff.");
    } finally {
      if (reqId.current === myReq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load() flips loading state then fetches; intentional on selection change.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    if (hasPair) void load(afterId, beforeId);
  }, [hasPair, afterId, beforeId, load]);

  if (!hasPair) {
    return (
      <EmptyState
        icon={<ListIcon className="size-6" />}
        title="Nothing to compare yet"
        description="A diff needs two completed scans. Run another scan for this environment to see what changed since last time."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Picker */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-4">
          <Picker
            label="Compare (newer)"
            value={afterId}
            options={completed.filter((s) => s.id !== beforeId)}
            onChange={setAfterId}
          />
          <span className="pb-2 text-sm text-faint">vs</span>
          <Picker
            label="Against (older)"
            value={beforeId}
            options={completed.filter((s) => s.id !== afterId)}
            onChange={setBeforeId}
          />
        </div>
      </Card>

      {error && <ErrorState title="Couldn’t load diff" message={error} onRetry={() => load(afterId, beforeId)} />}

      {loading && !result && (
        <Card className="p-5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="mt-4 h-40 w-full" />
        </Card>
      )}

      {result?.diff && !error && (
        <>
          <PostureDeltaCard result={result} />
          <div className="grid gap-4 lg:grid-cols-3">
            <Group
              tone="bad"
              title="New issues"
              findings={result.diff.introduced}
              empty="No new issues — nice."
            />
            <Group
              tone="good"
              title="Resolved"
              findings={result.diff.resolved}
              empty="Nothing resolved this round."
            />
            <Group
              tone="neutral"
              title="Still open"
              findings={result.diff.unchanged}
              empty="Nothing carried over."
            />
          </div>
          {result.pathDiff &&
            (result.pathDiff.introduced.length > 0 ||
              result.pathDiff.resolved.length > 0) && (
              <PathDiffSection pathDiff={result.pathDiff} />
            )}
        </>
      )}
    </div>
  );
}

function PathDiffSection({
  pathDiff,
}: {
  pathDiff: NonNullable<ScanDiffResult["pathDiff"]>;
}) {
  return (
    <div>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
        <RouteIcon className="size-4 text-muted" />
        Attack path changes
      </h3>
      <div className="grid gap-4 lg:grid-cols-2">
        <PathGroup
          tone="bad"
          title="New attack paths"
          paths={pathDiff.introduced}
          empty="No new attack paths."
        />
        <PathGroup
          tone="good"
          title="Resolved attack paths"
          paths={pathDiff.resolved}
          empty="No attack paths resolved."
        />
      </div>
    </div>
  );
}

function PathGroup({
  tone,
  title,
  paths,
  empty,
}: {
  tone: "bad" | "good";
  title: string;
  paths: AttackPathRef[];
  empty: string;
}) {
  const icon =
    tone === "bad" ? (
      <PlusIcon className="size-4 text-critical" />
    ) : (
      <CheckCircleIcon className="size-4 text-ok" />
    );
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            <span className="tnum rounded-full bg-surface-3 px-1.5 text-[11px] text-muted">
              {paths.length}
            </span>
          </span>
        }
        icon={icon}
      />
      <div className="flex-1 p-3">
        {paths.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-faint">{empty}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {paths.map((p) => (
              <li
                key={`${p.ruleId}-${p.entryKey}-${p.targetKey}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface-2/40 p-2.5"
              >
                <span className="min-w-0 truncate text-sm text-fg">{p.title}</span>
                <SeverityBadge severity={p.severity} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ScanHistoryItem[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-fg transition-colors focus-visible:border-primary focus-visible:outline-none"
      >
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {formatDateTime(s.startedAt)}
            {s.postureScore != null ? ` · posture ${s.postureScore}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function PostureDeltaCard({ result }: { result: ScanDiffResult }) {
  const d = result.diff!.postureDelta;
  const delta = d.delta;
  const improving = delta != null && delta > 0;
  const regressing = delta != null && delta < 0;
  const deltaColor = improving
    ? "text-ok bg-ok/12 ring-ok/30"
    : regressing
      ? "text-critical bg-critical/12 ring-critical/30"
      : "text-muted bg-surface-3 ring-border";

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-faint">
            Posture score
          </p>
          <div className="mt-1.5 flex items-center gap-3">
            <span className="tnum text-2xl font-bold text-muted">
              {d.before ?? "—"}
            </span>
            <span className="text-faint" aria-hidden>
              →
            </span>
            <span className="tnum text-4xl font-bold text-fg">{d.after ?? "—"}</span>
            {delta != null && (
              <span
                className={`tnum rounded-md px-2 py-1 text-sm font-semibold ring-1 ${deltaColor}`}
              >
                {signed(delta)}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-faint">
            {formatDateTime(result.before?.startedAt)} →{" "}
            {formatDateTime(result.after.startedAt)}
          </p>
        </div>
        <div className="flex items-center gap-5 text-sm">
          <Stat
            label="New"
            value={result.diff!.introduced.length}
            className="text-critical"
          />
          <Stat
            label="Resolved"
            value={result.diff!.resolved.length}
            className="text-ok"
          />
          <Stat
            label="Still open"
            value={result.diff!.unchanged.length}
            className="text-muted"
          />
        </div>
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <div className="text-center">
      <p className={`tnum text-2xl font-bold ${className}`}>{value}</p>
      <p className="text-[11px] text-faint">{label}</p>
    </div>
  );
}

function Group({
  tone,
  title,
  findings,
  empty,
}: {
  tone: "bad" | "good" | "neutral";
  title: string;
  findings: Finding[];
  empty: string;
}) {
  const icon =
    tone === "bad" ? (
      <PlusIcon className="size-4 text-critical" />
    ) : tone === "good" ? (
      <CheckCircleIcon className="size-4 text-ok" />
    ) : (
      <AlertTriangleIcon className="size-4 text-muted" />
    );

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            <span className="tnum rounded-full bg-surface-3 px-1.5 text-[11px] text-muted">
              {findings.length}
            </span>
          </span>
        }
        icon={icon}
      />
      <div className="flex-1 p-3">
        {findings.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-faint">{empty}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {findings.map((f) => (
              <li
                key={`${f.checkId ?? f.checkTitle}-${f.resourceId}-${f.region}`}
                className="rounded-lg border border-border/60 bg-surface-2/40 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium text-fg">
                    {f.checkTitle}
                  </p>
                  <SeverityBadge severity={f.severity} />
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-faint">
                  {f.resourceId} · {f.region}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

"use client";

/**
 * Dashboard orchestrator. Operates on the environment selected in the header
 * (AppProvider). Drives the full scan lifecycle by POLLING GET /api/scan/[id]
 * — queued -> scanning -> analyzing (chunk N/M) -> done — which is robust to the
 * tab being closed: on mount it restores the in-flight (or last) scan for the
 * selected environment and resumes from the DB. The analysis runs as a server
 * background job; an optional "watch it think" stream attaches read-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ActivityIcon,
  CheckCircleIcon,
  GaugeIcon,
  ListIcon,
  PlayIcon,
  PlusIcon,
  ServerIcon,
  ShieldIcon,
  SortIcon,
} from "@/components/icons";
import {
  PostureGauge,
  PostureGaugePending,
  SeverityDonut,
} from "@/components/charts";
import { ActionQueue } from "@/components/action-queue";
import { FindingsTable } from "@/components/findings-table";
import { LiveAnalysis } from "@/components/live-analysis";
import { QuickWins } from "@/components/quick-wins";
import { HealthReady, OllamaHealthBanner } from "@/components/health";
import { ScanProgress, type ProgressStage } from "@/components/scan-progress";
import { ScanHistory } from "@/components/scan-history";
import { ScanDiff } from "@/components/scan-diff";
import { ChangeCallout } from "@/components/change-callout";
import {
  EmptyState,
  ErrorState,
  PanelSkeleton,
  PartialReportNote,
} from "@/components/states";
import { Button, Card, CardHeader, Pill } from "@/components/ui/primitives";
import { useApp } from "@/components/app-context";
import {
  getScan,
  getScanDiff,
  getScanHistory,
  reanalyzeScan,
  startScan,
  streamAnalysis,
  type AnalysisStatus,
  type ScanDiffResult,
  type ScanHistoryItem,
  type ScanResponse,
  type ScanStatusRecord,
} from "@/lib/api-client";
import { getAllClearDemo, getDemoData } from "@/lib/demo-data";
import type { Analysis, Finding, FindingsSummary } from "@/lib/severity";

type Tab = "overview" | "queue" | "findings" | "history" | "changes";

const POLL_INTERVAL_MS = 1500;
const activeKey = (envId: string | null) => `cspm:activeScan:${envId ?? "__base__"}`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

const isAbort = (e: unknown) =>
  e instanceof DOMException && e.name === "AbortError";

/** Map the polled DB lifecycle to a single display stage. */
function deriveStage(s: ScanStatusRecord): ProgressStage {
  if (s.status === "queued") return "queued";
  if (s.status === "running") return "scanning";
  if (s.status === "error") return "scan-error";
  // status === "done": branch on the analysis sub-lifecycle.
  const a: AnalysisStatus | undefined = s.analysisStatus;
  if (a === "done") return "done";
  if (a === "running" || a === "pending") return "analyzing";
  return "analysis-error"; // error / interrupted / missing
}

function parseChunk(p?: string): { completed: number; total: number } | null {
  if (!p) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(p.trim());
  if (!m) return null;
  return { completed: Number(m[1]), total: Number(m[2]) };
}

interface View {
  stage: ProgressStage | "idle";
  findings: Finding[] | null;
  summary: FindingsSummary | null;
  report: Analysis | null;
  chunk: { completed: number; total: number } | null;
  startedAt: number | null;
  analysisStartedAt: number | null;
  scanError: string | null;
  analysisError: string | null;
}

const IDLE_VIEW: View = {
  stage: "idle",
  findings: null,
  summary: null,
  report: null,
  chunk: null,
  startedAt: null,
  analysisStartedAt: null,
  scanError: null,
  analysisError: null,
};

export function Dashboard() {
  const {
    environments,
    selectedId,
    selected,
    envError,
    health,
    healthRetrying,
    retryHealth,
    refreshEnvironments,
  } = useApp();

  const [tab, setTab] = useState<Tab>("overview");
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [rerunning, setRerunning] = useState(false);

  // Optional live "watch it think" stream (read-only attach).
  const [liveOn, setLiveOn] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [liveStreaming, setLiveStreaming] = useState(false);

  // Scan history + "what changed since last scan" (Phase 10).
  const [history, setHistory] = useState<ScanHistoryItem[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [changeSummary, setChangeSummary] = useState<ScanDiffResult | null>(null);

  // Demo data (?demo=1 | clear | analyzing) bypasses polling for screenshots/dev.
  const [demoActive, setDemoActive] = useState(false);
  const envsRef = useRef(environments);
  envsRef.current = environments;

  const envsLoaded = environments !== null;

  /* ---- scan history + "what changed since last scan" ---- */
  const loadHistory = useCallback(async (envId: string) => {
    try {
      const items = await getScanHistory(envId);
      setHistory(items);
      setHistoryError(null);
      // Compute the change summary from the two most recent completed scans.
      const completed = items.filter((s) => s.status === "done");
      if (completed.length >= 2) {
        try {
          setChangeSummary(await getScanDiff(completed[0].id, completed[1].id));
        } catch {
          setChangeSummary(null);
        }
      } else {
        setChangeSummary(null);
      }
    } catch (e) {
      setHistory([]);
      setHistoryError(e instanceof Error ? e.message : "Failed to load scan history.");
      setChangeSummary(null);
    }
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (demoActive || !envsLoaded || !selectedId) {
      setHistory(demoActive ? null : []);
      setChangeSummary(null);
      return;
    }
    setHistory(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    void loadHistory(selectedId);
  }, [selectedId, envsLoaded, demoActive, loadHistory]);

  /* ---- mount: optional demo data ---- */
  useEffect(() => {
    const demoParam =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("demo")
        : null;
    if (!demoParam) return;
    // One-time synchronous hydration of demo data on mount (dev/screenshots).
    /* eslint-disable react-hooks/set-state-in-effect */
    setDemoActive(true);
    if (demoParam === "analyzing") {
      const d = getDemoData();
      const startedMs = Date.now() - 22 * 60_000;
      const analysisMs = Date.now() - 7 * 60_000;
      setScan({
        status: {
          scanId: "demo",
          status: "done",
          createdAt: new Date(startedMs).toISOString(),
          updatedAt: new Date(analysisMs).toISOString(),
          analysisStatus: "running",
          analysisProgress: "3/6",
        },
        findings: d.findings,
        summary: d.summary,
        report: null,
      });
    } else {
      const d = demoParam === "clear" ? getAllClearDemo() : getDemoData();
      const report =
        demoParam === "partial"
          ? { ...d.analysis, partial: true, analyzedGroups: 5, totalGroups: 6 }
          : d.analysis;
      setScan({
        status: {
          scanId: "demo",
          status: "done",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          analysisStatus: "done",
        },
        findings: d.findings,
        summary: d.summary,
        report,
      });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  /* ---- resolve which scan to show when the environment changes / loads ---- */
  useEffect(() => {
    if (demoActive || !envsLoaded) return;
    const env = envsRef.current?.find((e) => e.id === selectedId) ?? null;
    const stored =
      typeof window !== "undefined"
        ? localStorage.getItem(activeKey(selectedId))
        : null;
    setActiveScanId(stored ?? env?.lastScanId ?? null);
    setScan(null);
    setLiveOn(false);
    setLiveText("");
  }, [selectedId, envsLoaded, demoActive]);

  /* ---- poll the active scan's lifecycle ---- */
  useEffect(() => {
    if (demoActive || !activeScanId) return;
    const ac = new AbortController();
    let stopped = false;
    void (async () => {
      try {
        for (;;) {
          const res = await getScan(activeScanId, ac.signal);
          if (stopped) return;
          setScan(res);
          const s = res.status;
          const running =
            s.analysisStatus === "running" || s.analysisStatus === "pending";
          const terminal =
            s.status === "error" || (s.status === "done" && !running);
          if (terminal) {
            if (s.status === "done" && s.analysisStatus === "done") {
              void refreshEnvironments(); // refresh posture score in header/cards
              if (selectedId) void loadHistory(selectedId); // new scan -> history/diff
            }
            return;
          }
          await sleep(POLL_INTERVAL_MS, ac.signal);
        }
      } catch (e) {
        if (isAbort(e) || stopped) return;
        const msg = e instanceof Error ? e.message : "Could not load the scan.";
        // A restored lastScanId can point at a scan that no longer exists
        // (e.g. history cleared). That's not an error — show the empty state.
        if (/not found/i.test(msg)) {
          if (typeof window !== "undefined") {
            localStorage.removeItem(activeKey(selectedId));
          }
          setScan(null);
          return;
        }
        setScan((prev) =>
          prev
            ? prev
            : {
                status: {
                  scanId: activeScanId,
                  status: "error",
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  error: msg,
                },
              },
        );
      }
    })();
    return () => {
      stopped = true;
      ac.abort();
    };
  }, [activeScanId, pollNonce, demoActive, selectedId, refreshEnvironments, loadHistory]);

  /* ---- live stream attach (read-only; never affects the job) ---- */
  useEffect(() => {
    if (!liveOn || !activeScanId || demoActive) return;
    const ac = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setLiveStreaming(true);
    setLiveText("");
    /* eslint-enable react-hooks/set-state-in-effect */
    void streamAnalysis(
      activeScanId,
      {
        onToken: (v) => setLiveText((p) => p + v),
        onDone: () => setLiveStreaming(false),
      },
      ac.signal,
    ).catch(() => {});
    return () => ac.abort();
  }, [liveOn, activeScanId, demoActive]);

  const view = useMemo<View>(() => {
    if (!scan) return IDLE_VIEW;
    const s = scan.status;
    return {
      stage: deriveStage(s),
      findings: scan.findings ?? null,
      summary: scan.summary ?? null,
      report: scan.report ?? null,
      chunk: parseChunk(s.analysisProgress),
      startedAt: s.createdAt ? Date.parse(s.createdAt) : null,
      analysisStartedAt: s.updatedAt ? Date.parse(s.updatedAt) : null,
      scanError: s.error ?? scan.error ?? null,
      analysisError: s.analysisError ?? null,
    };
  }, [scan]);

  const busy =
    view.stage === "queued" ||
    view.stage === "scanning" ||
    view.stage === "analyzing";

  /* ---- actions ---- */
  const runScan = useCallback(async () => {
    setDemoActive(false);
    setScan(null);
    setLiveOn(false);
    setLiveText("");
    setTab("overview");
    try {
      const { scanId } = await startScan(selectedId ?? undefined);
      if (typeof window !== "undefined") {
        localStorage.setItem(activeKey(selectedId), scanId);
      }
      setActiveScanId(scanId);
      setPollNonce((n) => n + 1);
    } catch (e) {
      setScan({
        status: {
          scanId: "",
          status: "error",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: e instanceof Error ? e.message : "Failed to start the scan.",
        },
      });
    }
  }, [selectedId]);

  const rerunAnalysis = useCallback(async () => {
    if (!activeScanId) return;
    setRerunning(true);
    setLiveText("");
    try {
      await reanalyzeScan(activeScanId);
      setPollNonce((n) => n + 1); // restart polling; job is pending again
    } catch {
      /* surfaced on the next poll */
    } finally {
      setRerunning(false);
    }
  }, [activeScanId]);

  const toggleLive = useCallback(() => {
    setLiveOn((v) => {
      if (v) setLiveStreaming(false);
      return !v;
    });
  }, []);

  // Open a historical scan's report — reuses the normal scan rendering path.
  const openScan = useCallback((scanId: string) => {
    setDemoActive(false);
    setScan(null);
    setLiveOn(false);
    setLiveText("");
    setActiveScanId(scanId);
    setPollNonce((n) => n + 1);
    setTab("overview");
  }, []);

  const itemCount = view.report?.items.length ?? 0;
  const isDemo = demoActive;
  const completedScans = history?.filter((s) => s.status === "done") ?? [];
  const historyCount = history?.length || undefined;

  const tabs: { key: Tab; label: string; icon: React.ReactNode; count?: number }[] =
    [
      { key: "overview", label: "Overview", icon: <GaugeIcon className="size-4" /> },
      {
        key: "queue",
        label: "Action queue",
        icon: <ListIcon className="size-4" />,
        count: itemCount || undefined,
      },
      {
        key: "findings",
        label: "Findings",
        icon: <ServerIcon className="size-4" />,
        count: view.findings?.length || undefined,
      },
      {
        key: "history",
        label: "History",
        icon: <ActivityIcon className="size-4" />,
        count: historyCount,
      },
      {
        key: "changes",
        label: "Changes",
        icon: <SortIcon className="size-4" />,
      },
    ];

  // No environments configured yet (and not in demo) — guide the user.
  if (!demoActive && envsLoaded && environments!.length === 0) {
    return (
      <main className="mx-auto max-w-7xl px-5 py-16">
        <EmptyState
          icon={<ServerIcon className="size-6" />}
          title="Add your first environment"
          description="Connect an AWS account to scan. Choose this machine's base scanner identity, or assume a read-only role in a target account. Nothing is modified — scans are read-only and analysis stays on this machine."
          action={
            <Link href="/environments">
              <Button icon={<PlusIcon className="size-4" />}>
                Add environment
              </Button>
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <div>
      {/* Toolbar: tabs + scan action (scoped to the selected environment) */}
      <div className="border-b border-border bg-bg/60">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-2.5">
          <nav className="flex gap-1">
            {tabs.map((t) => {
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  aria-current={active ? "page" : undefined}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-surface-2 text-fg"
                      : "text-faint hover:text-muted"
                  }`}
                >
                  {t.icon}
                  {t.label}
                  {t.count != null && (
                    <span className="tnum rounded-full bg-surface-3 px-1.5 text-[11px] text-muted">
                      {t.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {isDemo && <Pill className="hidden sm:inline-flex">Sample data</Pill>}
            {selected && (
              <span className="hidden text-xs text-faint md:inline">
                {selected.name}
              </span>
            )}
            <Button
              onClick={runScan}
              loading={busy}
              disabled={!envsLoaded && !demoActive}
              icon={!busy ? <PlayIcon className="size-4" /> : undefined}
            >
              {view.stage === "analyzing"
                ? "Analyzing…"
                : busy
                  ? "Scanning…"
                  : "Run AWS Scan"}
            </Button>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-7xl px-5 py-6">
        {envError && (
          <div className="mb-5">
            <ErrorState
              title="Couldn’t load environments"
              message={envError}
              onRetry={() => void refreshEnvironments()}
            />
          </div>
        )}

        <div className="mb-5">
          <OllamaHealthBanner
            health={health}
            onRetry={retryHealth}
            retrying={healthRetrying}
          />
        </div>

        {tab === "overview" && (
          <OverviewTab
            view={view}
            health={health}
            onRun={runScan}
            onRerunAnalysis={rerunAnalysis}
            rerunning={rerunning}
            onViewQueue={() => setTab("queue")}
            changeSummary={view.stage === "done" ? changeSummary : null}
            onViewChanges={() => setTab("changes")}
            live={{
              active: liveOn,
              onToggle: toggleLive,
              node: <LiveAnalysis text={liveText} streaming={liveStreaming} />,
            }}
          />
        )}

        {tab === "queue" && (
          <QueueTab
            view={view}
            onRun={runScan}
            onRerunAnalysis={rerunAnalysis}
            rerunning={rerunning}
          />
        )}

        {tab === "findings" && (
          <FindingsTab findings={view.findings} busy={busy} onRun={runScan} />
        )}

        {tab === "history" && (
          <ScanHistory
            items={history}
            error={historyError}
            currentScanId={activeScanId}
            onOpenScan={openScan}
            onRetry={() => selectedId && void loadHistory(selectedId)}
          />
        )}

        {tab === "changes" && <ScanDiff completed={completedScans} />}
      </main>
    </div>
  );
}

/* --------------------------------- Overview --------------------------------- */

function OverviewTab({
  view,
  health,
  onRun,
  onRerunAnalysis,
  rerunning,
  onViewQueue,
  changeSummary,
  onViewChanges,
  live,
}: {
  view: View;
  health: React.ComponentProps<typeof HealthReady>["health"];
  onRun: () => void;
  onRerunAnalysis: () => void;
  rerunning: boolean;
  onViewQueue: () => void;
  changeSummary: ScanDiffResult | null;
  onViewChanges: () => void;
  live: { active: boolean; onToggle: () => void; node: React.ReactNode };
}) {
  // Empty — no scan yet.
  if (view.stage === "idle") {
    return (
      <EmptyState
        icon={<ShieldIcon className="size-6" />}
        title="No scan yet"
        description="Run a read-only Prowler scan of this environment. Findings are normalized and a local LLM produces a prioritized remediation plan — nothing leaves this machine."
        action={
          <Button onClick={onRun} icon={<PlayIcon className="size-4" />}>
            Run AWS Scan
          </Button>
        }
      />
    );
  }

  const showProgress = view.stage !== "done";
  const hasData = view.findings !== null && view.summary !== null;

  return (
    <div className="flex flex-col gap-5">
      {/* "What changed since last scan" — only once this scan is fully done. */}
      {changeSummary?.diff && (
        <ChangeCallout result={changeSummary} onView={onViewChanges} />
      )}

      {showProgress && (
        <Card className="p-5">
          <ScanProgress
            stage={view.stage}
            chunk={view.chunk}
            startedAt={view.startedAt}
            analysisStartedAt={view.analysisStartedAt}
            scanError={view.scanError}
            analysisError={view.analysisError}
            onRerunScan={onRun}
            onRerunAnalysis={onRerunAnalysis}
            rerunning={rerunning}
            live={view.stage === "analyzing" ? live : undefined}
          />
        </Card>
      )}

      {/* While scanning (no findings yet), placeholders. */}
      {(view.stage === "queued" || view.stage === "scanning") && (
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <PanelSkeleton lines={4} />
          </div>
          <div className="lg:col-span-8">
            <PanelSkeleton lines={4} />
          </div>
        </div>
      )}

      {/* Posture + severity once findings exist (during analysis and after).
          The severity counts are real data, so the donut shows immediately; the
          numeric posture score only appears once analysis is done. */}
      {hasData && view.summary && (
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="flex flex-col lg:col-span-4">
            <CardHeader title="Posture score" icon={<GaugeIcon className="size-4" />} />
            <div className="flex flex-1 flex-col items-center justify-center px-5 py-3">
              {view.report ? (
                <PostureGauge score={view.report.posture_score} />
              ) : (
                <>
                  <PostureGaugePending />
                  <p className="mt-1 text-center text-xs text-faint">
                    Posture score calculated after analysis
                  </p>
                </>
              )}
            </div>
          </Card>
          <Card className="lg:col-span-8">
            <CardHeader
              title="Failed findings by severity"
              icon={<ActivityIcon className="size-4" />}
            />
            <div className="p-5">
              <SeverityDonut summary={view.summary} />
            </div>
          </Card>
        </div>
      )}

      {/* Partial-report note (rendered ABOVE the report, not instead of it). */}
      {view.report?.partial && (
        <PartialReportNote
          analyzed={view.report.analyzedGroups}
          total={view.report.totalGroups}
          onRerun={onRerunAnalysis}
          rerunning={rerunning}
        />
      )}

      {/* Analysis results. */}
      {view.report && (
        <div className="grid gap-4 lg:grid-cols-12">
          <Card className="lg:col-span-8">
            <CardHeader title="Executive summary" icon={<ShieldIcon className="size-4" />} />
            <div className="space-y-3 p-5">
              <p className="text-sm leading-relaxed text-muted">
                {view.report.executive_summary}
              </p>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <HealthReady health={health} />
                {view.report.items.length > 0 ? (
                  <Button variant="ghost" onClick={onViewQueue}>
                    View {view.report.items.length} prioritized actions →
                  </Button>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ok">
                    <CheckCircleIcon className="size-4" />
                    All clear — no action items
                  </span>
                )}
              </div>
            </div>
          </Card>
          <div className="lg:col-span-4">
            <QuickWins items={view.report.quick_wins} />
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Queue --------------------------------- */

function QueueTab({
  view,
  onRun,
  onRerunAnalysis,
  rerunning,
}: {
  view: View;
  onRun: () => void;
  onRerunAnalysis: () => void;
  rerunning: boolean;
}) {
  if (view.report)
    return (
      <div className="flex flex-col gap-4">
        {view.report.partial && (
          <PartialReportNote
            analyzed={view.report.analyzedGroups}
            total={view.report.totalGroups}
            onRerun={onRerunAnalysis}
            rerunning={rerunning}
          />
        )}
        <ActionQueue items={view.report.items} />
      </div>
    );

  if (view.stage === "analysis-error") {
    return (
      <ErrorState
        title="Analysis didn’t finish"
        message={`${
          view.analysisError ?? "The analysis was interrupted."
        } Your findings are saved — re-running reuses them.`}
        onRetry={onRerunAnalysis}
      />
    );
  }

  if (view.stage === "analyzing" || view.stage === "scanning" || view.stage === "queued")
    return (
      <div className="flex flex-col gap-3">
        <Card className="p-5">
          <p className="text-sm text-muted">
            {rerunning
              ? "Restarting analysis…"
              : view.stage === "analyzing"
                ? `Analyzing findings${
                    view.chunk
                      ? ` — chunk ${view.chunk.completed} of ${view.chunk.total}`
                      : ""
                  }. Your prioritized actions will appear here.`
                : "Scanning AWS — the action queue populates once analysis runs."}
          </p>
        </Card>
        <PanelSkeleton />
        <PanelSkeleton />
      </div>
    );

  return (
    <EmptyState
      icon={<ListIcon className="size-6" />}
      title="No prioritized actions yet"
      description="Once a scan completes and the analysis runs, your prioritized remediation queue appears here."
      action={
        <Button onClick={onRun} icon={<PlayIcon className="size-4" />}>
          Run AWS Scan
        </Button>
      }
    />
  );
}

/* --------------------------------- Findings --------------------------------- */

function FindingsTab({
  findings,
  busy,
  onRun,
}: {
  findings: Finding[] | null;
  busy: boolean;
  onRun: () => void;
}) {
  if (findings && findings.length > 0)
    return <FindingsTable findings={findings} />;
  if (busy)
    return (
      <div className="flex flex-col gap-3">
        <PanelSkeleton lines={2} />
        <PanelSkeleton lines={6} />
      </div>
    );
  return (
    <EmptyState
      icon={<ServerIcon className="size-6" />}
      title="No findings yet"
      description="Run a scan to populate the raw Prowler findings — the full, filterable “trust but verify” view."
      action={
        <Button onClick={onRun} icon={<PlayIcon className="size-4" />}>
          Run AWS Scan
        </Button>
      }
    />
  );
}

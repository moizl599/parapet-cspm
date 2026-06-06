"use client";

/**
 * Raw normalized Prowler findings — the "trust but verify" view. Filter by
 * search/severity/status/service and sort any column (aria-sort announced).
 */
import { useMemo, useState } from "react";
import { SearchIcon, SortIcon } from "@/components/icons";
import { SeverityBadge } from "@/components/ui/primitives";
import {
  SEVERITY_META,
  toSeverity,
  type Finding,
  type Severity,
} from "@/lib/severity";

type SortKey = "severity" | "status" | "service" | "region" | "checkTitle";
type SortDir = "asc" | "desc";

const STATUS_STYLE: Record<string, string> = {
  fail: "text-critical",
  pass: "text-ok",
  manual: "text-muted",
};

function StatusCell({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide ${
        STATUS_STYLE[status] ?? "text-muted"
      }`}
    >
      <span
        className={`size-1.5 rounded-full ${
          status === "fail"
            ? "bg-critical"
            : status === "pass"
              ? "bg-ok"
              : "bg-faint"
        }`}
        aria-hidden
      />
      {status}
    </span>
  );
}

export function FindingsTable({ findings }: { findings: Finding[] }) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [status, setStatus] = useState<string>("all");
  const [service, setService] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("severity");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const services = useMemo(
    () => Array.from(new Set(findings.map((f) => f.service))).sort(),
    [findings],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = findings.filter((f) => {
      if (severity !== "all" && f.severity !== severity) return false;
      if (status !== "all" && f.status !== status) return false;
      if (service !== "all" && f.service !== service) return false;
      if (
        q &&
        !`${f.checkTitle} ${f.resourceId} ${f.service} ${f.region}`
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return filtered.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "severity") {
        cmp =
          SEVERITY_META[toSeverity(a.severity)].rank -
          SEVERITY_META[toSeverity(b.severity)].rank;
      } else {
        cmp = String(a[sortKey]).localeCompare(String(b[sortKey]));
      }
      return cmp * dir;
    });
  }, [findings, query, severity, status, service, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const ariaSort = (key: SortKey): "ascending" | "descending" | "none" =>
    sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none";

  const selectClass =
    "rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg transition-colors hover:border-border-strong focus-visible:border-primary cursor-pointer";

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-50 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search findings, resources, regions…"
            aria-label="Search findings"
            className="w-full rounded-lg border border-border bg-surface-2 py-2 pl-9 pr-3 text-sm text-fg placeholder:text-faint transition-colors hover:border-border-strong focus-visible:border-primary"
          />
        </div>
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as Severity | "all")}
          aria-label="Filter by severity"
          className={selectClass}
        >
          <option value="all">All severities</option>
          {(Object.keys(SEVERITY_META) as Severity[]).map((s) => (
            <option key={s} value={s}>
              {SEVERITY_META[s].label}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
          className={selectClass}
        >
          <option value="all">All statuses</option>
          <option value="fail">Fail</option>
          <option value="pass">Pass</option>
          <option value="manual">Manual</option>
        </select>
        <select
          value={service}
          onChange={(e) => setService(e.target.value)}
          aria-label="Filter by service"
          className={selectClass}
        >
          <option value="all">All services</option>
          {services.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-surface text-xs uppercase tracking-wider text-faint">
              {(
                [
                  ["severity", "Severity"],
                  ["status", "Status"],
                  ["service", "Service"],
                  ["region", "Region"],
                  ["checkTitle", "Check"],
                ] as [SortKey, string][]
              ).map(([key, label]) => (
                <th
                  key={key}
                  aria-sort={ariaSort(key)}
                  className={`px-4 py-2.5 font-semibold ${key === "checkTitle" ? "w-full" : "whitespace-nowrap"}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(key)}
                    className="inline-flex cursor-pointer items-center gap-1.5 uppercase tracking-wider transition-colors hover:text-fg"
                  >
                    {label}
                    <SortIcon
                      className={`size-3 ${sortKey === key ? "text-primary-hi" : "text-faint/50"}`}
                    />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr
                key={f.id}
                className="border-b border-border/60 transition-colors last:border-0 hover:bg-surface-2/60"
              >
                <td className="px-4 py-2.5">
                  <SeverityBadge severity={f.severity} />
                </td>
                <td className="px-4 py-2.5">
                  <StatusCell status={f.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                  {f.service}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                  {f.region}
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-fg">{f.checkTitle}</span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">
                    {f.resourceId}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted">
            No findings match the current filters.
          </div>
        )}
      </div>

      <p className="tnum text-xs text-faint">
        Showing {rows.length} of {findings.length} findings
      </p>
    </div>
  );
}

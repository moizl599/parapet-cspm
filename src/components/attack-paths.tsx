"use client";

/**
 * Attack Paths tab (AP-4). Ranked cards, each a compact horizontal chain
 * (Internet → exposed node → … → target) with capability badges, a reassessed
 * severity badge, hop count, and a confidence chip. Expand → the grounded LLM
 * narrative; paths beyond the top-N have no narrative and render their computed
 * metadata with a small note (never an empty panel).
 *
 * Honest scope: v1 is toxic-combination detection, not full graph analysis —
 * surfaced via the confidence chip (heuristic vs real-edge link).
 */
import { Fragment, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  GlobeIcon,
  RouteIcon,
  ServerIcon,
  ZapIcon,
} from "@/components/icons";
import {
  Card,
  CopyButton,
  EffortBadge,
  SeverityBadge,
} from "@/components/ui/primitives";
import { EmptyState, ErrorState, PanelSkeleton } from "@/components/states";
import type {
  AttackPathDto,
  AttackPathNodeDto,
  BreakTheChainStep,
} from "@/lib/api-client";

/* ------------------------------ capabilities ------------------------------ */

const CAPABILITY_META: Record<string, { label: string; dot: string; text: string }> =
  {
    exposed_internet: { label: "Internet-exposed", dot: "bg-high", text: "text-high" },
    publicly_accessible: {
      label: "Publicly accessible",
      dot: "bg-high",
      text: "text-high",
    },
    privileged: { label: "Privileged", dot: "bg-critical", text: "text-critical" },
    holds_data: { label: "Holds data", dot: "bg-primary", text: "text-primary-hi" },
    unencrypted: { label: "Unencrypted", dot: "bg-medium", text: "text-medium" },
    weak_auth: { label: "Weak auth", dot: "bg-medium", text: "text-medium" },
    credential_exposure: {
      label: "Credential exposure",
      dot: "bg-high",
      text: "text-high",
    },
    logging_blind: { label: "Logging blind", dot: "bg-faint", text: "text-faint" },
  };

function capMeta(cap: string) {
  return (
    CAPABILITY_META[cap] ?? {
      label: cap.replace(/_/g, " "),
      dot: "bg-faint",
      text: "text-faint",
    }
  );
}

function CapabilityBadge({ cap }: { cap: string }) {
  const m = capMeta(cap);
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium">
      <span className={`size-1.5 rounded-full ${m.dot}`} aria-hidden />
      <span className={m.text}>{m.label}</span>
    </span>
  );
}

const isExposed = (n: AttackPathNodeDto) =>
  n.capabilities.includes("exposed_internet") ||
  n.capabilities.includes("publicly_accessible");

const RELATION_LABEL: Record<string, string> = {
  uses_role: "uses role",
  in_security_group: "in security group",
  can_assume: "can assume",
  can_access: "can access",
};

/* ------------------------------- chain visual ----------------------------- */

function ChainNode({
  node,
  role,
}: {
  node: AttackPathNodeDto;
  role: "entry" | "target" | "hop";
}) {
  const ring =
    role === "target"
      ? "border-critical/45"
      : role === "entry"
        ? "border-high/45"
        : "border-border-strong";
  return (
    <div
      className={`flex w-40 shrink-0 flex-col gap-1 rounded-lg border bg-surface-2 px-2.5 py-2 ${ring}`}
    >
      <div className="flex items-center gap-1.5">
        <ServerIcon className="size-3.5 shrink-0 text-faint" />
        <span className="truncate font-mono text-xs text-fg" title={node.key}>
          {node.name}
        </span>
      </div>
      <span className="truncate text-[10px] text-faint">{node.type}</span>
      {node.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.capabilities.map((c) => (
            <CapabilityBadge key={c} cap={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center px-1" aria-hidden>
      <span className="whitespace-nowrap text-[10px] text-faint">{label}</span>
      <span className="text-faint">→</span>
    </div>
  );
}

function relationBetween(path: AttackPathDto, aKey: string, bKey: string): string {
  const e = path.edges.find(
    (x) =>
      (x.srcKey === aKey && x.dstKey === bKey) ||
      (x.srcKey === bKey && x.dstKey === aKey),
  );
  return e ? (RELATION_LABEL[e.relation] ?? e.relation.replace(/_/g, " ")) : "→";
}

function chainAria(path: AttackPathDto): string {
  const names = path.nodes.map((n) => n.name).join(" then ");
  const start = path.nodes[0] && isExposed(path.nodes[0]) ? "Internet to " : "";
  return `Attack chain: ${start}${names}`;
}

function AttackChain({ path }: { path: AttackPathDto }) {
  const startsAtInternet = path.nodes[0] ? isExposed(path.nodes[0]) : false;
  return (
    <div
      role="img"
      aria-label={chainAria(path)}
      className="flex items-stretch gap-1 overflow-x-auto pb-1"
    >
      {startsAtInternet && (
        <>
          <div className="flex w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-high/40 bg-high/8 px-2 py-2">
            <GlobeIcon className="size-4 text-high" />
            <span className="text-[10px] font-medium text-high">Internet</span>
          </div>
          <Connector label="reaches" />
        </>
      )}
      {path.nodes.map((n, i) => {
        const role =
          i === path.nodes.length - 1 && path.nodes.length > 1
            ? "target"
            : i === 0
              ? "entry"
              : "hop";
        return (
          <Fragment key={n.key}>
            {i > 0 && (
              <Connector label={relationBetween(path, path.nodes[i - 1].key, n.key)} />
            )}
            <ChainNode node={n} role={path.nodes.length === 1 ? "target" : role} />
          </Fragment>
        );
      })}
    </div>
  );
}

/* -------------------------------- chips ----------------------------------- */

function ConfidenceChip({ confidence }: { confidence: "high" | "medium" | "low" }) {
  const map = {
    high: { label: "High confidence", cls: "text-ok bg-ok/12 ring-ok/30" },
    medium: { label: "Heuristic", cls: "text-medium bg-medium/12 ring-medium/30" },
    low: { label: "Low confidence", cls: "text-faint bg-surface-3 ring-border" },
  } as const;
  const m = map[confidence];
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${m.cls}`}
      title={
        confidence === "high"
          ? "Uses a real relationship edge from the scan data"
          : "Same-resource toxic combination (heuristic)"
      }
    >
      {m.label}
    </span>
  );
}

function FalsePositiveChip({ risk }: { risk: "low" | "medium" | "high" }) {
  const cls =
    risk === "high"
      ? "text-high"
      : risk === "medium"
        ? "text-medium"
        : "text-ok";
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="text-faint">False-positive risk:</span>
      <span className={`font-semibold capitalize ${cls}`}>{risk}</span>
    </span>
  );
}

/* ------------------------------- break step ------------------------------- */

const COMMAND_RE = /^(aws|\$|sudo|terraform|kubectl|az|gcloud)\b/;

function BreakStep({ step, index }: { step: BreakTheChainStep; index: number }) {
  const codeSpans = [...step.action.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const wholeIsCommand = codeSpans.length === 0 && COMMAND_RE.test(step.action.trim());
  const commands = wholeIsCommand ? [step.action.trim()] : codeSpans;
  const parts = step.action.split(/(`[^`]+`)/g);

  return (
    <li className="flex gap-3">
      <span className="tnum mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-fg">{step.link}</span>
          <EffortBadge effort={step.effort} />
        </div>
        {!wholeIsCommand && (
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {parts.map((part, i) =>
              part.startsWith("`") && part.endsWith("`") ? (
                <code
                  key={i}
                  className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.8em] text-primary-hi"
                >
                  {part.slice(1, -1)}
                </code>
              ) : (
                <Fragment key={i}>{part}</Fragment>
              ),
            )}
          </p>
        )}
        {commands.map((cmd, i) => (
          <div key={i} className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-xs text-fg">
              {cmd}
            </code>
            <CopyButton value={cmd} label="Copy CLI command" />
          </div>
        ))}
      </div>
    </li>
  );
}

/* --------------------------------- card ----------------------------------- */

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-faint">
        {label}
      </p>
      {children}
    </div>
  );
}

function AttackPathCard({ path }: { path: AttackPathDto }) {
  const [open, setOpen] = useState(false);
  const hops = Math.max(0, path.nodes.length - 1);
  const n = path.narrative;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer flex-col gap-3 px-4 py-3.5 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={path.severity} />
          <ConfidenceChip confidence={path.confidence} />
          <span className="tnum rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] text-muted">
            {hops === 0 ? "single resource" : `${hops} hop${hops > 1 ? "s" : ""}`}
          </span>
          {path.blindSpot && (
            <span className="inline-flex items-center gap-1 rounded-md bg-medium/12 px-2 py-0.5 text-[11px] font-medium text-medium ring-1 ring-medium/30">
              <AlertTriangleIcon className="size-3" /> Logging blind
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 text-xs text-faint">
            {n ? "narrative" : "metadata"}
            <ChevronDownIcon
              className={`size-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          </span>
        </div>
        <p className="text-sm font-medium text-fg">
          {n?.summary ?? path.title}
        </p>
        <AttackChain path={path} />
      </button>

      {open && (
        <div className="animate-rise space-y-5 border-t border-border px-4 py-4">
          {n ? (
            <>
              <Detail label="Attack scenario">
                <p className="rounded-lg border border-critical/20 bg-critical/8 px-3 py-2 text-sm leading-relaxed text-fg">
                  {n.attack_scenario}
                </p>
              </Detail>
              {n.blast_radius && (
                <Detail label="Blast radius">
                  <p className="text-sm leading-relaxed text-muted">{n.blast_radius}</p>
                </Detail>
              )}
              {n.severity_rationale && (
                <Detail label="Why this severity">
                  <p className="text-sm leading-relaxed text-muted">
                    {n.severity_rationale}
                  </p>
                </Detail>
              )}
              {n.break_the_chain.length > 0 && (
                <Detail label="Break the chain">
                  <ol className="flex flex-col gap-3">
                    {n.break_the_chain.map((s, i) => (
                      <BreakStep key={i} step={s} index={i} />
                    ))}
                  </ol>
                </Detail>
              )}
              <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                {n.confidence_note && (
                  <p className="text-xs leading-relaxed text-faint">
                    {n.confidence_note}
                  </p>
                )}
                <FalsePositiveChip risk={n.false_positive_risk} />
              </div>
            </>
          ) : (
            <>
              <Detail label="Resources in this path">
                <ul className="flex flex-col gap-2">
                  {path.nodes.map((node) => (
                    <li key={node.key} className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-xs text-muted">{node.name}</code>
                      <span className="text-[10px] text-faint">{node.type}</span>
                      {node.capabilities.map((c) => (
                        <CapabilityBadge key={c} cap={c} />
                      ))}
                    </li>
                  ))}
                </ul>
              </Detail>
              <p className="rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-xs leading-relaxed text-muted">
                Narrative not generated (lower-priority path). The chain above is
                computed from real findings; only the top paths are narrated by the
                local model to bound analysis time. Re-run analysis to refresh.
              </p>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- list ----------------------------------- */

export function AttackPaths({
  paths,
  error,
  onRetry,
}: {
  paths: AttackPathDto[] | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <ErrorState title="Couldn’t load attack paths" message={error} onRetry={onRetry} />
    );
  }
  if (paths === null) {
    return (
      <div className="flex flex-col gap-3">
        <PanelSkeleton lines={2} />
        <PanelSkeleton lines={2} />
      </div>
    );
  }
  if (paths.length === 0) {
    return (
      <EmptyState
        icon={<RouteIcon className="size-6" />}
        title="No attack paths detected"
        description="No toxic combinations or internet-to-sensitive chains were found from this scan's failed findings. Re-scan after changes to keep this current."
      />
    );
  }

  const critical = paths.filter((p) => p.severity === "critical").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <ZapIcon className="size-4 text-primary-hi" />
          {paths.length} attack path{paths.length > 1 ? "s" : ""}
          {critical > 0 && (
            <span className="text-critical"> · {critical} critical</span>
          )}
        </h2>
        <p className="inline-flex items-center gap-1.5 text-xs text-faint">
          <CheckCircleIcon className="size-3.5" />
          Computed from real findings — the model only narrates them
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {paths.map((p) => (
          <AttackPathCard key={p.id} path={p} />
        ))}
      </div>
    </div>
  );
}

"use client";

/**
 * Prioritized action queue — analysis items sorted by priority_rank. Each card
 * expands to a detail panel; CLI commands in remediation steps get a copy
 * button. Card header is a real <button> with aria-expanded for keyboard a11y.
 */
import { Fragment, useState } from "react";
import { ChevronDownIcon, ExternalLinkIcon, ServerIcon } from "@/components/icons";
import {
  Card,
  CopyButton,
  EffortBadge,
  Pill,
  SeverityBadge,
} from "@/components/ui/primitives";
import type { AnalysisItem } from "@/lib/severity";

const COMMAND_RE = /^(aws|\$|sudo|terraform|kubectl|az|gcloud)\b/;

/** Render one remediation step: prose with inline code, plus copyable commands. */
function RemediationStep({ step, index }: { step: string; index: number }) {
  const codeSpans = [...step.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const wholeIsCommand =
    codeSpans.length === 0 && COMMAND_RE.test(step.trim());

  const commands = wholeIsCommand
    ? [step.trim().replace(/^\$\s*/, "")]
    : codeSpans.filter((c) => COMMAND_RE.test(c.trim()) || codeSpans.length > 0);

  // Prose with inline <code> for backticked spans (skip if the whole step is a command).
  const parts = step.split(/(`[^`]+`)/g);

  return (
    <li className="flex gap-3">
      <span className="tnum mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-muted">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        {!wholeIsCommand && (
          <p className="text-sm leading-relaxed text-fg">
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
          <div
            key={i}
            className={`flex items-center gap-2 ${wholeIsCommand && i === 0 ? "" : "mt-2"}`}
          >
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

function ActionCard({ item }: { item: AnalysisItem }) {
  const [open, setOpen] = useState(false);
  const resourceCount = item.affected_resources?.length ?? 0;

  return (
    <Card className="overflow-hidden transition-colors hover:border-border-strong">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left"
      >
        <span className="tnum flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-sm font-semibold text-muted">
          {item.priority_rank}
        </span>
        <SeverityBadge severity={item.severity} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {item.title}
        </span>
        <span className="hidden items-center gap-1.5 text-xs text-faint sm:inline-flex">
          <ServerIcon className="size-3.5" />
          <span className="tnum">{resourceCount}</span>
        </span>
        <EffortBadge effort={item.effort} />
        <ChevronDownIcon
          className={`size-4 shrink-0 text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="animate-rise space-y-5 border-t border-border px-4 py-4 sm:px-[3.75rem]">
          <Detail label="Why it matters">
            <p className="text-sm leading-relaxed text-muted">
              {item.why_it_matters}
            </p>
          </Detail>

          {item.attack_scenario && (
            <Detail label="Attack scenario">
              <p className="rounded-lg border border-critical/20 bg-critical/8 px-3 py-2 text-sm leading-relaxed text-fg">
                {item.attack_scenario}
              </p>
            </Detail>
          )}

          <Detail label="Remediation">
            <ol className="flex flex-col gap-3">
              {item.remediation_steps.map((step, i) => (
                <RemediationStep key={i} step={step} index={i} />
              ))}
            </ol>
          </Detail>

          <div className="grid gap-5 sm:grid-cols-2">
            {item.risk_of_fix && (
              <Detail label="Risk of fix">
                <p className="text-sm leading-relaxed text-muted">
                  {item.risk_of_fix}
                </p>
              </Detail>
            )}
            {resourceCount > 0 && (
              <Detail label={`Affected resources (${resourceCount})`}>
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                  {item.affected_resources.map((r, i) => (
                    <code
                      key={i}
                      className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted"
                    >
                      {r}
                    </code>
                  ))}
                </div>
              </Detail>
            )}
          </div>

          {item.references && item.references.length > 0 && (
            <Detail label="References">
              <ul className="flex flex-wrap gap-2">
                {item.references.map((ref, i) => {
                  const isUrl = /^https?:\/\//i.test(ref);
                  return isUrl ? (
                    <li key={i}>
                      <a
                        href={ref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-primary-hi transition-colors hover:bg-surface-3"
                      >
                        <ExternalLinkIcon className="size-3" />
                        {ref.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}
                      </a>
                    </li>
                  ) : (
                    <li key={i}>
                      <Pill>{ref}</Pill>
                    </li>
                  );
                })}
              </ul>
            </Detail>
          )}
        </div>
      )}
    </Card>
  );
}

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

export function ActionQueue({ items }: { items: AnalysisItem[] }) {
  const sorted = [...items].sort((a, b) => a.priority_rank - b.priority_rank);
  return (
    <div className="flex flex-col gap-3">
      {sorted.map((item, i) => (
        <ActionCard key={`${item.priority_rank}-${i}`} item={item} />
      ))}
    </div>
  );
}

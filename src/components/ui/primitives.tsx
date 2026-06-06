"use client";

/**
 * Small reusable primitives shared across dashboard views. Kept dependency-free
 * and on-token (severity/surface/focus styles come from globals.css).
 */
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CopyIcon, CheckIcon, LoaderIcon } from "@/components/icons";
import {
  EFFORT_META,
  SEVERITY_META,
  toSeverity,
  type Effort,
} from "@/lib/severity";

/* ----------------------------- Card ----------------------------- */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface/80 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  icon,
  action,
}: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-fg">
        {icon ? <span className="text-muted">{icon}</span> : null}
        {title}
      </h2>
      {action}
    </div>
  );
}

/* ----------------------------- Button ----------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = "primary",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer";
  const variants = {
    primary:
      "bg-primary text-white hover:bg-primary-hi focus-visible:bg-primary-hi",
    secondary:
      "border border-border-strong bg-surface-2 text-fg hover:bg-surface-3",
    ghost: "text-muted hover:bg-surface-2 hover:text-fg",
  } as const;
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <LoaderIcon className="size-4 animate-spin" />
      ) : icon ? (
        <span className="size-4">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}

/* ----------------------------- Badges ----------------------------- */

export function SeverityBadge({
  severity,
  className = "",
}: {
  severity: string;
  className?: string;
}) {
  const meta = SEVERITY_META[toSeverity(severity)];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${meta.badge} ${className}`}
    >
      <span className={`size-1.5 rounded-full ${meta.dot}`} aria-hidden />
      {meta.label}
    </span>
  );
}

export function EffortBadge({ effort }: { effort: Effort }) {
  const meta = EFFORT_META[effort] ?? EFFORT_META.moderate;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

export function Pill({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted ${className}`}
    >
      {children}
    </span>
  );
}

/* ----------------------------- Skeleton ----------------------------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton rounded-md ${className}`} aria-hidden />;
}

/* ----------------------------- CopyButton ----------------------------- */

/** Copy-to-clipboard control used on CLI commands in remediation steps. */
export function CopyButton({
  value,
  label = "Copy command",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-surface-2 text-muted transition-colors hover:bg-surface-3 hover:text-fg"
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-ok" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

/**
 * Severity + effort presentation tokens — the single client-side source of
 * truth for how risk levels render. Class strings are written out in full
 * (not interpolated) so Tailwind's scanner emits them.
 */
import type { Severity } from "@/lib/ocsf";
import type { Effort } from "@/lib/analyze";

export type { Severity } from "@/lib/ocsf";
export type { Finding, FindingsSummary } from "@/lib/ocsf";
export type { Analysis, AnalysisItem, Effort } from "@/lib/analyze";

export interface SeverityStyle {
  label: string;
  /** Sort rank, 0 = most severe. */
  rank: number;
  /** Token color as a CSS var reference, for SVG fills/strokes. */
  color: string;
  text: string;
  dot: string;
  badge: string;
  bar: string;
}

export const SEVERITY_META: Record<Severity, SeverityStyle> = {
  critical: {
    label: "Critical",
    rank: 0,
    color: "var(--color-critical)",
    text: "text-critical",
    dot: "bg-critical",
    badge: "bg-critical/12 text-critical ring-1 ring-critical/30",
    bar: "bg-critical",
  },
  high: {
    label: "High",
    rank: 1,
    color: "var(--color-high)",
    text: "text-high",
    dot: "bg-high",
    badge: "bg-high/12 text-high ring-1 ring-high/30",
    bar: "bg-high",
  },
  medium: {
    label: "Medium",
    rank: 2,
    color: "var(--color-medium)",
    text: "text-medium",
    dot: "bg-medium",
    badge: "bg-medium/12 text-medium ring-1 ring-medium/30",
    bar: "bg-medium",
  },
  low: {
    label: "Low",
    rank: 3,
    color: "var(--color-low)",
    text: "text-low",
    dot: "bg-low",
    badge: "bg-low/12 text-low ring-1 ring-low/30",
    bar: "bg-low",
  },
  informational: {
    label: "Info",
    rank: 4,
    color: "var(--color-info)",
    text: "text-info",
    dot: "bg-info",
    badge: "bg-info/12 text-info ring-1 ring-info/30",
    bar: "bg-info",
  },
};

/** Severities ordered most→least severe (for legends, charts, sorting). */
export const SEVERITY_ORDER: Severity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

/** Coerce an arbitrary string into a known Severity (defensive for raw data). */
export function toSeverity(value: string): Severity {
  return (value in SEVERITY_META ? value : "informational") as Severity;
}

export const EFFORT_META: Record<Effort, { label: string; className: string }> =
  {
    "quick-win": {
      label: "Quick win",
      className: "bg-ok/12 text-ok ring-1 ring-ok/30",
    },
    moderate: {
      label: "Moderate",
      className: "bg-low/12 text-low ring-1 ring-low/25",
    },
    involved: {
      label: "Involved",
      className: "bg-high/12 text-high ring-1 ring-high/25",
    },
  };

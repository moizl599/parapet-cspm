"use client";

/**
 * Inline-SVG data viz (no chart dependency). Both are accessible: role="img"
 * with a descriptive aria-label, and the donut is paired with a numeric legend
 * so meaning never relies on color alone.
 */
import { SEVERITY_META, SEVERITY_ORDER, type FindingsSummary } from "@/lib/severity";

/**
 * Largest-remainder rounding: rounds each share to a whole percent while
 * guaranteeing the results sum to exactly 100 (naive per-item Math.round can
 * total 99 or 101).
 */
function largestRemainderPercents(counts: number[], total: number): number[] {
  if (total <= 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const result = raw.map(Math.floor);
  let remainder = 100 - result.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < byFrac.length && remainder > 0; k++) {
    result[byFrac[k].i] += 1;
    remainder -= 1;
  }
  return result;
}

/** Score band -> token color + label. Higher score = better posture. */
function scoreBand(score: number): { color: string; label: string } {
  if (score >= 85) return { color: "var(--color-ok)", label: "Strong" };
  if (score >= 70) return { color: "var(--color-low)", label: "Fair" };
  if (score >= 50) return { color: "var(--color-medium)", label: "At risk" };
  if (score >= 30) return { color: "var(--color-high)", label: "Weak" };
  return { color: "var(--color-critical)", label: "Critical" };
}

/** Semicircular gauge, 0–100. */
export function PostureGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const band = scoreBand(clamped);
  // Semicircle arc geometry.
  const r = 80;
  const cx = 100;
  const cy = 100;
  const circumference = Math.PI * r; // half circle
  const offset = circumference * (1 - clamped / 100);

  return (
    <div
      className="relative flex flex-col items-center"
      role="img"
      aria-label={`Posture score ${clamped} out of 100 — ${band.label}`}
    >
      <svg viewBox="0 0 200 116" className="w-full max-w-[300px]">
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke={band.color}
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: "stroke-dashoffset 0.9s var(--ease-out-soft)",
            filter: `drop-shadow(0 0 6px ${band.color}55)`,
          }}
        />
      </svg>
      <div className="-mt-12 flex flex-col items-center">
        <span
          className="tnum text-5xl font-bold leading-none"
          style={{ color: band.color }}
        >
          {clamped}
        </span>
        <span className="mt-1 text-xs font-medium uppercase tracking-widest text-faint">
          {band.label}
        </span>
      </div>
    </div>
  );
}

/**
 * Neutral gauge shown while analysis is still running. We deliberately do NOT
 * render a provisional number — the heuristic estimate can swing far from the
 * final LLM score, which reads as a bug. Show an empty track + "—" instead.
 */
export function PostureGaugePending() {
  const r = 80;
  const cx = 100;
  const cy = 100;
  return (
    <div
      className="relative flex flex-col items-center"
      role="img"
      aria-label="Posture score is being calculated"
    >
      <svg viewBox="0 0 200 116" className="w-full max-w-[300px]">
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth={14}
          strokeLinecap="round"
        />
      </svg>
      <div className="-mt-12 flex flex-col items-center">
        <span className="text-5xl font-bold leading-none text-faint">—</span>
        <span className="mt-1 text-xs font-medium uppercase tracking-widest text-faint">
          Calculating
        </span>
      </div>
    </div>
  );
}

/**
 * Posture-over-time sparkline. Points are chronological (oldest → newest) on a
 * fixed 0–100 domain so the slope is meaningful. Trend color: green if the most
 * recent score is at least the first, red if it regressed.
 */
export function PostureSparkline({
  points,
}: {
  points: { score: number; label?: string }[];
}) {
  if (points.length === 0) return null;
  const w = 260;
  const h = 60;
  const pad = 8;
  const x = (i: number) =>
    points.length === 1 ? w / 2 : pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (s: number) =>
    h - pad - (Math.max(0, Math.min(100, s)) / 100) * (h - 2 * pad);

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`)
    .join(" ");
  const area = `${line} L ${x(points.length - 1).toFixed(1)} ${h - pad} L ${x(0).toFixed(1)} ${h - pad} Z`;

  const first = points[0].score;
  const last = points[points.length - 1].score;
  const improving = last >= first;
  const color = improving ? "var(--color-ok)" : "var(--color-critical)";
  const gradId = improving ? "spark-up" : "spark-down";

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="w-full"
      role="img"
      aria-label={`Posture trend across ${points.length} scans, from ${first} to ${last}`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(p.score)}
          r={i === points.length - 1 ? 3.5 : 2.5}
          fill={i === points.length - 1 ? color : "var(--color-surface)"}
          stroke={color}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

/** Donut of FAILED findings by severity, with a numeric legend. */
export function SeverityDonut({ summary }: { summary: FindingsSummary }) {
  const total = summary.totalFailed;
  const segments = SEVERITY_ORDER.map((sev) => ({
    sev,
    count: summary.bySeverity[sev] ?? 0,
  })).filter((s) => s.count > 0);

  const r = 56;
  const circumference = 2 * Math.PI * r;
  let acc = 0;

  return (
    <div className="flex items-center gap-6">
      <div
        className="relative shrink-0"
        role="img"
        aria-label={`${total} failed findings by severity: ${segments
          .map((s) => `${s.count} ${SEVERITY_META[s.sev].label}`)
          .join(", ")}`}
      >
        <svg viewBox="0 0 150 150" className="size-36 -rotate-90">
          <circle
            cx="75"
            cy="75"
            r={r}
            fill="none"
            stroke="var(--color-surface-3)"
            strokeWidth={16}
          />
          {total > 0 &&
            segments.map((s) => {
              const len = (s.count / total) * circumference;
              const dash = `${len} ${circumference - len}`;
              const el = (
                <circle
                  key={s.sev}
                  cx="75"
                  cy="75"
                  r={r}
                  fill="none"
                  stroke={SEVERITY_META[s.sev].color}
                  strokeWidth={16}
                  strokeDasharray={dash}
                  strokeDashoffset={-acc}
                  strokeLinecap="butt"
                />
              );
              acc += len;
              return el;
            })}
        </svg>
        <div className="absolute inset-0 flex rotate-0 flex-col items-center justify-center">
          <span className="tnum text-3xl font-bold text-fg">{total}</span>
          <span className="text-[11px] uppercase tracking-wider text-faint">
            failed
          </span>
        </div>
      </div>

      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {(() => {
          const pcts = largestRemainderPercents(
            segments.map((s) => s.count),
            total,
          );
          return segments.map((s, i) => (
            <li key={s.sev} className="flex items-center gap-2.5 text-sm">
              <span
                className={`size-2.5 shrink-0 rounded-sm ${SEVERITY_META[s.sev].dot}`}
                aria-hidden
              />
              <span className="text-muted">{SEVERITY_META[s.sev].label}</span>
              <span className="ml-auto tnum font-semibold text-fg">
                {s.count}
              </span>
              <span className="tnum w-9 text-right text-xs text-faint">
                {pcts[i]}%
              </span>
            </li>
          ));
        })()}
        {total === 0 && (
          <li className="text-sm text-muted">No failed findings.</li>
        )}
      </ul>
    </div>
  );
}

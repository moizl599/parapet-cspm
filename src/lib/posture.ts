/** Posture score (0-100, higher = better) -> color band. Pure, client-safe. */
export interface PostureBand {
  color: string; // CSS var reference
  label: string;
  className: string; // text-* token class
  dot: string; // bg-* token class
}

export function postureBand(score: number | null | undefined): PostureBand {
  if (score == null)
    return { color: "var(--color-faint)", label: "No scan", className: "text-faint", dot: "bg-faint" };
  if (score >= 85)
    return { color: "var(--color-ok)", label: "Strong", className: "text-ok", dot: "bg-ok" };
  if (score >= 70)
    return { color: "var(--color-low)", label: "Fair", className: "text-low", dot: "bg-low" };
  if (score >= 50)
    return { color: "var(--color-medium)", label: "At risk", className: "text-medium", dot: "bg-medium" };
  if (score >= 30)
    return { color: "var(--color-high)", label: "Weak", className: "text-high", dot: "bg-high" };
  return { color: "var(--color-critical)", label: "Critical", className: "text-critical", dot: "bg-critical" };
}

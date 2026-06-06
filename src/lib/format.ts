/** Presentation formatters. Pure, client-safe. */

/** Compact local date-time, e.g. "Jun 5, 02:20 PM". Null → "—". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Signed integer, e.g. +11 / -3 / 0. */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

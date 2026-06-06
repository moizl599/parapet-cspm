"use client";

import { ZapIcon } from "@/components/icons";

/** High-value, low-effort fixes surfaced from the analysis. */
export function QuickWins({ items }: { items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="animate-rise rounded-xl border border-ok/25 bg-ok/8 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ok">
        <ZapIcon className="size-4" />
        Quick wins
      </h2>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((win, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm text-fg">
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ok"
              aria-hidden
            />
            <span className="leading-relaxed">{win}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

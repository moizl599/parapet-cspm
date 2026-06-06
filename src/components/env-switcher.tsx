"use client";

/**
 * Header environment switcher. The selected environment drives the dashboard,
 * action queue, findings, and Run-Scan across the app (persisted in
 * localStorage via AppProvider). Keyboard-accessible listbox-style dropdown.
 */
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  CheckIcon,
  ChevronUpDownIcon,
  PlusIcon,
  ServerIcon,
} from "@/components/icons";
import { Skeleton } from "@/components/ui/primitives";
import { useApp } from "@/components/app-context";
import { postureBand } from "@/lib/posture";
import type { EnvironmentDto } from "@/lib/api-client";

export function EnvSwitcher() {
  const { environments, selected, selectEnvironment } = useApp();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Loading.
  if (environments === null) {
    return <Skeleton className="h-9 w-44" />;
  }

  // Empty — no environments configured yet.
  if (environments.length === 0) {
    return (
      <Link
        href="/environments"
        className="inline-flex items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-2 px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-3 hover:text-fg"
      >
        <PlusIcon className="size-4" />
        Add environment
      </Link>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[15rem] items-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-surface-3 focus-visible:outline-none"
      >
        <ServerIcon className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-left">
          {selected?.name ?? "Select environment"}
        </span>
        <ChevronUpDownIcon className="size-4 shrink-0 text-faint" />
      </button>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="Environments"
          className="animate-rise absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-xl border border-border bg-surface shadow-xl shadow-black/40"
        >
          <ul className="max-h-80 overflow-y-auto py-1">
            {environments.map((env) => (
              <EnvOption
                key={env.id}
                env={env}
                selected={env.id === selected?.id}
                onSelect={() => {
                  selectEnvironment(env.id);
                  setOpen(false);
                }}
              />
            ))}
          </ul>
          <div className="border-t border-border p-1">
            <Link
              href="/environments"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ServerIcon className="size-4" />
              Manage environments
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function EnvOption({
  env,
  selected,
  onSelect,
}: {
  env: EnvironmentDto;
  selected: boolean;
  onSelect: () => void;
}) {
  const band = postureBand(env.lastPostureScore);
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
          selected ? "bg-surface-2" : "hover:bg-surface-2"
        }`}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${band.dot}`}
          aria-hidden
          title={band.label}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">
            {env.name}
          </span>
          <span className="block truncate text-xs text-faint">
            {env.targetAccountId ?? (env.authMode === "role" ? "Assume role" : "Base account")}
          </span>
        </span>
        {selected && <CheckIcon className="size-4 shrink-0 text-primary-hi" />}
      </button>
    </li>
  );
}

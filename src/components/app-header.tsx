"use client";

/**
 * Global application header: brand, primary nav (Dashboard / Environments), the
 * environment switcher, and the Ollama health chip. Rendered once in the root
 * layout so every page shares the same chrome and the selected environment.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { GaugeIcon, ServerIcon } from "@/components/icons";
import { HealthChip } from "@/components/health";
import { EnvSwitcher } from "@/components/env-switcher";
import { useApp } from "@/components/app-context";

const NAV = [
  { href: "/", label: "Dashboard", icon: GaugeIcon, match: (p: string) => p === "/" },
  {
    href: "/environments",
    label: "Environments",
    icon: ServerIcon,
    match: (p: string) => p.startsWith("/environments"),
  },
] as const;

export function AppHeader() {
  const pathname = usePathname();
  const { health } = useApp();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- flat static SVG mark; next/image adds no value for a tiny local asset */}
          <img
            src="/parapet-mark.svg"
            alt="Parapet"
            width={41}
            height={32}
            className="h-8 w-auto"
          />
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-wide text-fg">
              Parapet
            </p>
            <p className="text-[11px] text-faint">Cloud security posture</p>
          </div>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          {NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-surface-2 text-fg"
                    : "text-faint hover:bg-surface-2/60 hover:text-muted"
                }`}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <HealthChip health={health} />
          <EnvSwitcher />
        </div>
      </div>
    </header>
  );
}

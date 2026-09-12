"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useLocationOrigin } from "@/hooks/useLocationOrigin";
import { cx } from "@/lib/cx";
import { ActivityIcon, BarsIcon, ImperiumMark, LedgerIcon, PromptIcon, SlidersIcon } from "./icons";
import { StreamStatusPill } from "./StreamStatus";

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Command", icon: PromptIcon },
  { href: "/activity/", label: "Activity", icon: ActivityIcon },
  { href: "/audit/", label: "Audit", icon: LedgerIcon },
  { href: "/stats/", label: "Stats", icon: BarsIcon },
  { href: "/settings/", label: "Settings", icon: SlidersIcon },
];

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function isActivePath(pathname: string, href: string): boolean {
  return trimSlash(pathname) === trimSlash(href);
}

/** Sidebar on wide screens, a bottom tab bar on small ones. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const origin = useLocationOrigin();
  useKeyboardInset();

  return (
    <div className="min-h-dvh lg:pl-60">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-panel lg:flex">
        <Link href="/" className="flex h-16 items-center gap-2.5 px-5 text-fg">
          <ImperiumMark className="h-7 w-7" />
          <span className="wordmark">Imperium</span>
        </Link>
        <nav aria-label="Primary" className="flex-1 px-3 pt-2">
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex h-10 items-center gap-3 rounded-lg px-3 text-[14px] font-medium transition-colors duration-150",
                      active ? "bg-control text-fg" : "text-fg-muted hover:bg-raised hover:text-fg",
                    )}
                  >
                    <item.icon className={cx("h-[18px] w-[18px]", active ? "text-fg" : "text-fg-faint")} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="space-y-2 border-t border-line px-5 py-4">
          <StreamStatusPill />
          <p className="truncate font-mono text-[11px] text-fg-faint" title={origin}>
            {origin.replace(/^https?:\/\//, "")}
          </p>
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b border-line bg-ground/90 pt-safe backdrop-blur-md lg:hidden">
        <div className="flex h-14 items-center justify-between px-page">
          <Link href="/" className="flex min-h-11 items-center gap-2 text-fg">
            <ImperiumMark className="h-6 w-6" />
            <span className="wordmark">Imperium</span>
          </Link>
          <StreamStatusPill />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 pb-safe backdrop-blur-md lg:hidden">
        <ul className="grid h-tabbar grid-cols-5 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
          {NAV_ITEMS.map((item) => {
            const active = isActivePath(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex h-full flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition-colors duration-150",
                    active ? "text-fg" : "text-fg-faint hover:text-fg-muted",
                  )}
                >
                  <item.icon className="h-[22px] w-[22px]" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { PageTitle, cx } from "@/components/ui/primitives";

export type StrategiesTab = "build" | "community" | "automate";

const TABS: Array<{ id: StrategiesTab; href: string; label: string; hint: string }> = [
  { id: "build", href: "/build", label: "Build", hint: "Sliders, a template or a draft" },
  { id: "community", href: "/community", label: "Community", hint: "Published baskets · 7-day pulse" },
  { id: "automate", href: "/automate", label: "Automate", hint: "Runs by itself, or with your OK" },
];

/**
 * One section for everything that produces a plan: build a basket, borrow one from the community,
 * or repeat one on a schedule. Tabs are real routes, so deep links and the back button keep working.
 */
export function StrategiesShell({ tab, action, compact = false, children }: { tab: StrategiesTab; action?: ReactNode; compact?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      {!compact && <PageTitle index="03 — Strategies" title="Build, share, repeat." lead="Baskets you build, baskets others published, and plans that buy on a schedule — automatically within limits the chain enforces, or with a confirmation per run." action={action} />}
      <div role="tablist" aria-label="Strategy sections" className="grid grid-cols-3 p-1 rounded-[8px] bg-surface-muted">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <Link key={t.id} href={t.href} role="tab" aria-selected={active} aria-current={active ? "page" : undefined} className={cx("h-11 rounded-[6px] px-1 md:px-2 text-[12px] md:text-[13px] font-medium transition-fast flex flex-col items-center justify-center leading-tight", active ? "bg-canvas border border-line text-primary" : "text-ink-secondary hover:text-ink")}>
              <span>{t.label}</span>
              <span className="hidden lg:block font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">{t.hint}</span>
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}

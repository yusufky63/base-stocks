"use client";

import Link from "next/link";
import { ArrowUpRight, Repeat } from "lucide-react";
import { useAutomation } from "@/hooks/useAutomation";
import { formatUsd, timeAgo } from "@/lib/format";
import { cadenceLabel } from "@/lib/auto-invest";
import { Module, ModuleHeader, Badge } from "@/components/ui/primitives";

/** Compact pointer to the Automate page: how many plans, what is due, when the next one runs. */
export function AutomationCard() {
  const automation = useAutomation();
  const active = automation.active;
  const due = automation.due;
  const next = active
    .filter((p) => !p.due && p.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  const autoCount = active.filter((p) => p.config.mode === "auto").length;
  const perMonth = active.reduce((s, p) => s + ((p.config.amountUsd ?? 0) * 30) / Math.max(1, p.config.cadenceDays ?? 30), 0);

  return (
    <Module>
      <ModuleHeader
        title="Plans"
        action={
          <Link href="/automate" className="text-[13px] text-primary font-medium inline-flex items-center gap-1">
            Manage <ArrowUpRight size={13} strokeWidth={1.75} />
          </Link>
        }
      />
      <div className="p-4 flex items-start gap-3">
        <span className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-[6px] bg-primary-soft text-primary">
          <Repeat size={16} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 text-[13px] flex flex-col gap-1">
          {!automation.signedIn ? (
            <span className="text-ink-secondary">Buy a stock or a basket on a schedule — automatically within limits you set, or with a confirmation per run. Sign in on the Automate page to see yours.</span>
          ) : automation.isLoading ? (
            <span className="text-ink-secondary">Loading plans…</span>
          ) : active.length === 0 ? (
            <span className="text-ink-secondary">No plans yet. A weekly $25 is enough to start; set it up on the Automate page.</span>
          ) : (
            <>
              <span className="font-medium inline-flex items-center gap-2 flex-wrap">
                {active.length} active plan{active.length > 1 ? "s" : ""}
                {autoCount > 0 && <Badge tone="primary">{autoCount} automatic</Badge>}
                {due.length > 0 && <Badge tone="warning">{due.length} due</Badge>}
              </span>
              <span className="text-ink-secondary">
                {perMonth > 0 ? `About ${formatUsd(perMonth)} a month. ` : ""}
                {due.length > 0
                  ? due[0]!.config.mode === "auto"
                    ? "A run is due; the keeper will pick it up, or run it yourself from Automate."
                    : "A run is waiting for your confirmation."
                  : next
                    ? `Next run ${next.config.mode === "auto" ? "runs by itself" : "asks you"} ${timeAgo(next.nextRunAt!).replace(/ ago$/, "")} from now · ${cadenceLabel(next.config.cadenceDays ?? 7).toLowerCase()}.`
                    : "Nothing due."}
              </span>
            </>
          )}
        </span>
      </div>
    </Module>
  );
}

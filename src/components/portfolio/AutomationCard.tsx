"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Repeat } from "lucide-react";
import { apiGet } from "@/lib/client-api";
import type { AutomationRule } from "@/domain/community";
import { useAuth } from "@/hooks/useAuth";
import { Module, ModuleHeader } from "@/components/ui/primitives";

type RuleDTO = AutomationRule & { due: boolean; missed?: number };

/** Compact pointer to the Automate page with the wallet's active plans and what is due. */
export function AutomationCard() {
  const auth = useAuth();
  const rules = useQuery({ queryKey: ["automation", auth.signedInAs ?? ""], queryFn: async () => (await apiGet<{ rules: RuleDTO[] }>("/api/automation")).rules, enabled: auth.isSignedIn, staleTime: 60_000 });
  const active = (rules.data ?? []).filter((r) => r.status === "active");
  const due = active.filter((r) => r.due);
  const missedTotal = due.reduce((sum, r) => sum + (r.missed ?? 1), 0);
  return (
    <Module>
      <ModuleHeader
        title="Automation"
        action={
          <Link href="/automate" className="text-[13px] text-primary font-medium inline-flex items-center gap-1">
            Manage <ArrowUpRight size={13} strokeWidth={1.75} />
          </Link>
        }
      />
      <div className="p-4 flex items-center gap-3">
        <span className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-[6px] bg-primary-soft text-primary">
          <Repeat size={16} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 text-[13px]">
          {!auth.isSignedIn ? (
            <span className="text-ink-secondary">Recurring buys and basket plans, each run confirmed by you. Sign in on the Automate page to see yours.</span>
          ) : rules.isLoading ? (
            <span className="text-ink-secondary">Loading plans…</span>
          ) : active.length === 0 ? (
            <span className="text-ink-secondary">No plans yet. Set up a weekly buy or a basket plan on the Automate page.</span>
          ) : (
            <>
              <span className="block font-medium">
                {active.length} active plan{active.length > 1 ? "s" : ""}
                {due.length > 0 ? ` · ${due.length} due now` : ""}
              </span>
              <span className="block text-ink-secondary">
                {due.length === 0
                  ? "Nothing due; runs wait for your confirmation."
                  : missedTotal > due.length
                    ? `${missedTotal} scheduled runs went by unconfirmed. Running now buys once, not ${missedTotal} times.`
                    : "A run is waiting for your confirmation."}
              </span>
            </>
          )}
        </span>
      </div>
    </Module>
  );
}

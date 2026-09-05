"use client";

import { useState } from "react";
import { AlertTriangle, Settings2 } from "lucide-react";
import { TOTAL_BPS, USDC_ALLOCATION_KEY } from "@/domain/portfolio";
import type { AutomationRuleDTO } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { useAutomation } from "@/hooks/useAutomation";
import { useManualRun } from "@/hooks/useManualRun";
import { useNow } from "@/hooks/useNow";
import { cadenceLabel } from "@/lib/auto-invest";
import { formatUsd, timeAgo } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { Module, ModuleHeader, Button, Badge, Skeleton, cx } from "@/components/ui/primitives";
import { SignInButton } from "@/components/layout/SignInButton";
import { ExecutionProgress } from "@/components/build/ExecutionProgress";
import { PlanManageSheet, fundingNote } from "./PlanManageSheet";

/**
 * Your plans, one line each: what it buys, how it runs, when it runs next, and whether anything
 * needs you. Everything else — running, pausing, terms, funding, cancelling, history — lives
 * behind one Manage button, so the list stays a list.
 */
export function PlanList() {
  const automation = useAutomation();
  const { data: assets } = useAssets();
  const manual = useManualRun();
  const now = useNow();
  const [managing, setManaging] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  const plans = automation.plans;
  const ended = plans.filter((p) => p.status === "cancelled");
  const shown = plans
    .filter((p) => showEnded || p.status !== "cancelled")
    .sort((a, b) => Number(b.due) - Number(a.due) || rank(a.status) - rank(b.status) || (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
  const logoOf = (address: string) => assets?.assets.find((a) => a.canonicalId === address.toLowerCase());
  const managed = plans.find((p) => p.id === managing) ?? null;

  return (
    <Module>
      <ModuleHeader index="A" title="Your plans" action={automation.signedIn && plans.length > 0 ? <span className="font-mono text-[11px] text-ink-muted">{automation.active.length} active</span> : undefined} />
      {!automation.signedIn ? (
        <div className="p-4 flex flex-col gap-2">
          <p className="text-[13px] text-ink-secondary">Plans are stored against your wallet. Sign in to see and manage yours.</p>
          <SignInButton label="Sign in to see your plans" />
        </div>
      ) : automation.isLoading ? (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : plans.length === 0 ? (
        <p className="px-4 py-5 text-[14px] text-ink-secondary">No plans yet. Start one on the left: a weekly $25 into one stock is enough to see how it feels.</p>
      ) : (
        <>
          {manual.execution && manual.summary && !managing && (
            <div className="p-4 border-b border-line">
              <ExecutionProgress execution={manual.execution} currentStepId={manual.currentStepId} running={manual.running} summary={manual.summary} onRetry={() => manual.retry()} onClose={() => manual.reset()} verb="buys" />
            </div>
          )}
          {shown.map((r) => {
            const auto = r.config.mode === "auto";
            const allocations = r.config.allocations ?? (r.config.assetAddress ? [{ assetAddress: r.config.assetAddress, weightBps: TOTAL_BPS }] : []);
            const stocks = allocations.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
            const title = r.type === "recurring-buy" ? (logoOf(r.config.assetAddress ?? "")?.underlying ?? "stock") : (r.config.basketName ?? "basket");
            const expired = !!r.config.expiryAt && now > 0 && r.config.expiryAt < now;
            const attention = fundingNote(r) ?? (r.config.lastError && r.status === "active" ? "Last run failed" : null);
            return (
              <div key={r.id} className={cx("px-4 py-3 border-b border-line last:border-b-0 flex items-center gap-3", r.status === "cancelled" && "opacity-60")}>
                <span className="flex -space-x-2 shrink-0">
                  {stocks.slice(0, 3).map((a) => {
                    const info = logoOf(a.assetAddress as string);
                    return <AssetLogo key={a.assetAddress} src={info?.logoURI} symbol={info?.symbol ?? "?"} size={28} className="ring-2 ring-canvas rounded-full" />;
                  })}
                  {stocks.length > 3 && <span className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-surface-muted text-[10px] font-mono ring-2 ring-canvas">+{stocks.length - 3}</span>}
                </span>
                <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[14px] truncate">
                      {formatUsd(r.config.amountUsd)} · {title}
                    </span>
                    <span className="text-[12px] text-ink-secondary">{cadenceLabel(r.config.cadenceDays ?? 7).toLowerCase()}</span>
                    {auto ? <Badge tone="primary">automatic</Badge> : <Badge>you confirm</Badge>}
                    {r.config.towardTarget && <Badge>toward target</Badge>}
                    <StatusBadge rule={r} expired={expired} />
                  </div>
                  <div className="text-[12px] text-ink-secondary font-mono truncate">
                    {r.status === "cancelled" ? "cancelled" : expired ? "expired" : r.due ? `due since ${new Date(r.nextRunAt!).toLocaleDateString()}${r.missed > 1 ? ` · ${r.missed} runs went by` : ""}` : r.nextRunAt ? `next ${new Date(r.nextRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}
                    {r.lastRunAt ? ` · last ${timeAgo(r.lastRunAt)}` : ""}
                  </div>
                  {attention && (
                    <div className="text-[12px] text-warning-fg inline-flex items-center gap-1.5">
                      <AlertTriangle size={12} strokeWidth={1.75} /> {attention}
                    </div>
                  )}
                </div>
                <Button size="sm" variant={r.due && r.status === "active" ? "primary" : "secondary"} className="shrink-0" onClick={() => setManaging(r.id)}>
                  <Settings2 size={13} strokeWidth={1.75} /> Manage
                </Button>
              </div>
            );
          })}
          {ended.length > 0 && (
            <button type="button" onClick={() => setShowEnded((v) => !v)} className="w-full px-4 py-2.5 text-[12px] text-ink-secondary hover:text-ink text-left border-t border-line">
              {showEnded ? "Hide" : "Show"} {ended.length} cancelled plan{ended.length === 1 ? "" : "s"}
            </button>
          )}
        </>
      )}
      {automation.signedIn && plans.length > 0 && (
        <p className="px-4 py-3 border-t border-line text-[12px] text-ink-muted">Automatic plans are read from the AutoInvest contract on every visit; the app never marks one as run by itself. Manual plans move to the next date only after a run actually bought something.</p>
      )}
      {managed && <PlanManageSheet key={managed.id} rule={managed} open onClose={() => setManaging(null)} manual={manual} />}
    </Module>
  );
}

function rank(status: AutomationRuleDTO["status"]): number {
  return status === "active" ? 0 : status === "paused" ? 1 : status === "proposed" ? 2 : 3;
}

function StatusBadge({ rule, expired }: { rule: AutomationRuleDTO; expired: boolean }) {
  if (rule.status === "cancelled") return <Badge>cancelled</Badge>;
  if (expired) return <Badge>expired</Badge>;
  if (rule.status === "paused") return <Badge tone="warning">paused</Badge>;
  if (rule.due) return <Badge tone="positive">due now</Badge>;
  return <Badge tone="positive">active</Badge>;
}

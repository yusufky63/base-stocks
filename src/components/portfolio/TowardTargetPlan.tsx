"use client";

import { useState } from "react";
import Link from "next/link";
import { Repeat } from "lucide-react";
import type { Allocation } from "@/domain/portfolio";
import { apiPost, ApiError } from "@/lib/client-api";
import { humanizeError } from "@/lib/errors";
import { formatUsd } from "@/lib/format";
import { cadenceLabel } from "@/lib/auto-invest";
import { useAutomation } from "@/hooks/useAutomation";
import { Button } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorBanner } from "@/components/common/display";

const AMOUNTS = [10, 25, 50, 100] as const;
const CADENCES = [7, 14, 30] as const;

/**
 * "Return to my target, a little at a time": a manual plan that, on each due date, buys only what
 * is *under* the saved target and nothing else. Chosen over a true automatic rebalance on purpose:
 *
 * - it never sells, so a bad price or a paused stock can never turn into a forced exit;
 * - it is a `manual` plan, so every run is proposed by the app and confirmed leg by leg in the
 *   wallet — nothing runs in the background, and the AutoInvest contract is not involved;
 * - the legs are computed at run time from the live holdings, so it always pulls toward the
 *   target as it stands that day, not toward the mix as it was when the plan was made.
 *
 * When the mix is already within threshold the run records "in balance" and moves to the next
 * date, so a plan is never stuck "due" for want of something to buy.
 */
export function TowardTargetPlan({ allocations }: { allocations: Allocation[] }) {
  const automation = useAutomation();
  const existing = automation.plans.find((p) => p.config.towardTarget && p.status !== "cancelled") ?? null;
  const [amount, setAmount] = useState<number>(25);
  const [cadence, setCadence] = useState<number>(14);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPost("/api/automation", { type: "recurring-basket", mode: "manual", allocations, basketName: "Toward my target", amountUsd: amount, cadenceDays: cadence, towardTarget: true });
      await automation.invalidate();
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : humanizeError(err).message);
    } finally {
      setSaving(false);
    }
  };

  if (existing) {
    return (
      <div className="px-4 py-3 border-t border-line flex flex-wrap items-center gap-3">
        <p className="text-[12px] text-ink-secondary flex-1 min-w-[220px]">
          <Repeat size={12} strokeWidth={1.75} className="inline -mt-0.5 mr-1" />
          A top-up plan pulls toward this target: {formatUsd(existing.config.amountUsd)} {cadenceLabel(existing.config.cadenceDays ?? 7).toLowerCase()}, buys only, each run confirmed in your wallet
          {existing.status === "paused" ? " · paused" : existing.due ? " · due now" : ""}.
        </p>
        <Link href="/automate" className="text-[13px] text-primary font-medium whitespace-nowrap">
          Manage in Automate →
        </Link>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-t border-line flex flex-col gap-3">
      {!open ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[12px] text-ink-secondary flex-1 min-w-[220px]">Drifting again next month? A top-up plan buys only what is under target, on a schedule, and never sells.</p>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            <Repeat size={13} strokeWidth={1.75} /> Return to target on a schedule
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Up to, per run</span>
              <Segmented<number> size="sm" ariaLabel="Amount per run" value={amount} onChange={setAmount} options={AMOUNTS.map((a) => ({ value: a, label: formatUsd(a) }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">How often</span>
              <Segmented<number> size="sm" ariaLabel="How often" value={cadence} onChange={setCadence} options={CADENCES.map((c) => ({ value: c, label: cadenceLabel(c) }))} />
            </div>
          </div>
          <p className="text-[12px] text-ink-muted">
            Each run reads your holdings that day, splits the amount across the stocks that are under target in proportion to how far under they are, and asks your wallet to confirm each buy. Nothing is ever sold, nothing runs unattended. If the mix is within threshold, the run is logged as in balance and skips to the next date.
          </p>
          {error && <ErrorBanner message={error} />}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" loading={saving} onClick={() => void create()}>
              Create the plan
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

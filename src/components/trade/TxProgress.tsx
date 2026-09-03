"use client";

import { Check } from "lucide-react";
import type { TradeState } from "@/domain/trade";
import { cx } from "@/components/ui/primitives";
import { TxLink } from "@/components/common/display";

const STEPS: Array<{ id: "SUBMITTED" | "PRECONFIRMED" | "CONFIRMED"; label: string }> = [
  { id: "SUBMITTED", label: "Submitted" },
  { id: "PRECONFIRMED", label: "Preconfirmed" },
  { id: "CONFIRMED", label: "Confirmed" },
];
const ORDER: Record<string, number> = { SUBMITTED: 0, PRECONFIRMED: 1, CONFIRMED: 2 };

/** Submitted → Preconfirmed → Confirmed. Never shows "confirmed" before the status says so. */
const ORDER_STEPS: typeof STEPS = [
  { id: "SUBMITTED", label: "Order placed" },
  { id: "PRECONFIRMED", label: "Matching" },
  { id: "CONFIRMED", label: "Filled" },
];

export function TxProgress({ state, txHash, order }: { state: TradeState; txHash?: string; order?: boolean }) {
  const idx = ORDER[state] ?? -1;
  const steps = order ? ORDER_STEPS : STEPS;
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <ol className="grid grid-cols-3 gap-1">
        {steps.map((s, i) => {
          const done = idx >= i;
          const active = idx === i && state !== "CONFIRMED";
          return (
            <li key={s.id} className="flex flex-col gap-2">
              <div className={cx("h-1 rounded-full transition-base", done ? "bg-primary" : "bg-surface-muted")} />
              <div className={cx("flex items-center gap-1 text-[12px] font-mono uppercase tracking-[0.06em]", done ? "text-ink" : "text-ink-muted")}>
                {done && !active ? <Check size={12} strokeWidth={2} /> : active ? <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin" /> : null}
                {s.label}
              </div>
            </li>
          );
        })}
      </ol>
      {txHash && <TxLink hash={txHash} />}
    </div>
  );
}

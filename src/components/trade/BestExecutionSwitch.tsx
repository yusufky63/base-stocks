"use client";

import { Sparkles } from "lucide-react";
import type { TradeExecutionAdvice } from "@/domain/trade";
import { cx } from "@/components/ui/primitives";

interface Props {
  enabled: boolean;
  onChange: (v: boolean) => void;
  /** The router's verdict for the current quote; null while there is no quote, or when a manual route pick overrides everything. */
  advice: TradeExecutionAdvice | null;
  /** A provider was picked by hand in the comparison, which takes precedence over the switch. */
  manual: boolean;
}

/**
 * The best-execution switch under the live quote. On: CoW Protocol's batch auction takes the
 * trade whenever its quote is competitive with the best swap, and the router's note says whether
 * it did. Off: the note only appears when the trade is large enough for the mode to be worth
 * suggesting, with the switch as the answer. A manual route pick wins over both.
 */
export function BestExecutionSwitch({ enabled, onChange, advice, manual }: Props) {
  const suggested = !enabled && !!advice?.suggested;
  const note = manual ? "A route picked by hand is used as-is; best execution is not applied." : advice?.note ?? null;
  return (
    <div className={cx("border rounded-[8px] px-3 py-2.5 flex flex-col gap-1.5", suggested ? "border-primary/50 bg-primary-soft/40" : "border-line")}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 min-w-0">
          <Sparkles size={14} strokeWidth={1.75} className={cx("shrink-0", enabled || suggested ? "text-primary" : "text-ink-muted")} aria-hidden />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">Best execution</span>
            <span className="block text-[11px] text-ink-muted truncate">CoW batch auction when it is competitive · no gas · no front-running</span>
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Best execution"
          onClick={() => onChange(!enabled)}
          className={cx("relative shrink-0 w-10 h-6 rounded-full border transition-fast", enabled ? "bg-primary border-primary" : "bg-surface-muted border-line-strong")}
        >
          <span className={cx("absolute top-[3px] w-4 h-4 rounded-full bg-canvas shadow transition-[left] duration-200", enabled ? "left-[19px]" : "left-[3px]")} aria-hidden />
        </button>
      </div>
      {note && (
        <p className={cx("text-[12px] leading-snug", suggested ? "text-ink" : "text-ink-muted")} role="status">
          {note}
          {suggested && (
            <>
              {" "}
              <button type="button" onClick={() => onChange(true)} className="text-primary font-medium hover:underline">
                Turn it on
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

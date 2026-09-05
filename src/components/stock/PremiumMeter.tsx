"use client";

import { formatPct, formatUsd } from "@/lib/format";
import { cx } from "@/components/ui/primitives";

/** The meter's range; a move beyond it pins the marker to the edge and says so in the figure. */
const RANGE_PCT = 20;

/**
 * Premium or discount of the pool price against the Chainlink reference, as a gauge. The
 * question it answers is the first one a weekend trader asks — "am I paying the stock price or
 * something else?" — and the answer is a position on a line, not a percentage to interpret.
 * Nothing is fetched: `deviationPct` is already on the price view.
 */
export function PremiumMeter({ deviationPct, marketUsd, referenceUsd, stale, paused, className }: { deviationPct: number | null | undefined; marketUsd: number | null | undefined; referenceUsd: number | null | undefined; stale?: boolean; paused?: boolean; className?: string }) {
  if (deviationPct === null || deviationPct === undefined || marketUsd === null || marketUsd === undefined || referenceUsd === null || referenceUsd === undefined) return null;
  const clamped = Math.max(-RANGE_PCT, Math.min(RANGE_PCT, deviationPct));
  const pos = ((clamped + RANGE_PCT) / (2 * RANGE_PCT)) * 100;
  const size = Math.abs(deviationPct);
  const tone = size < 1 ? "text-ink-secondary" : size < 5 ? "text-ink" : deviationPct > 0 ? "text-warning-fg" : "text-positive-fg";
  const word = deviationPct > 0 ? "above" : deviationPct < 0 ? "below" : "at";
  return (
    <div className={cx("flex flex-col gap-1.5", className)} title={`Pool ${formatUsd(marketUsd, { precise: true })} vs Chainlink reference ${formatUsd(referenceUsd, { precise: true })}${stale ? " (reference stale)" : ""}${paused ? " (reference frozen)" : ""}`}>
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="font-mono uppercase tracking-[0.1em] text-[10px] text-ink-muted">Premium vs reference</span>
        <span className={cx("font-mono num", tone)}>
          {size < 0.05 ? "at reference" : `${formatPct(Math.abs(deviationPct), { sign: false, digits: size < 10 ? 2 : 1 })} ${word}`}
          {(stale || paused) && <span className="text-ink-muted"> · ref {paused ? "frozen" : "stale"}</span>}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-surface-muted overflow-hidden" role="img" aria-label={`Pool price ${formatPct(deviationPct, { sign: true })} versus the Chainlink reference`}>
        <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" aria-hidden />
        <div className="absolute inset-y-0 left-[37.5%] w-px bg-line" aria-hidden />
        <div className="absolute inset-y-0 left-[62.5%] w-px bg-line" aria-hidden />
        <div className={cx("absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full border-2 border-canvas", size < 1 ? "bg-ink-muted" : size < 5 ? "bg-ink" : deviationPct > 0 ? "bg-warning-fg" : "bg-positive-fg")} style={{ left: `${pos}%` }} aria-hidden />
      </div>
      <div className="flex justify-between font-mono text-[9px] text-ink-muted">
        <span>−{RANGE_PCT}%</span>
        <span>−5%</span>
        <span>ref</span>
        <span>+5%</span>
        <span>+{RANGE_PCT}%</span>
      </div>
    </div>
  );
}

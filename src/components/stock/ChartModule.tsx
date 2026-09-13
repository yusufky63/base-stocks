"use client";

import dynamic from "next/dynamic";
import { useState, useSyncExternalStore } from "react";
import { BarChart3, TrendingUp } from "lucide-react";
import { TIMEFRAMES, type PriceView, type Timeframe } from "@/domain/market";
import { useChart } from "@/hooks/queries";
import { useChartStyle } from "@/hooks/useSettings";
import { Chip, Skeleton, cx } from "@/components/ui/primitives";
import { timeAgo } from "@/lib/format";

const PriceChart = dynamic(() => import("./PriceChart"), { ssr: false, loading: () => <Skeleton className="h-[320px]" /> });

const noop = () => () => {};
/** The reader's zone, named next to the source because the axis is drawn in it. Empty on the server so hydration matches. */
function useTimeZone(): string {
  return useSyncExternalStore(noop, () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "", () => "");
}

/**
 * Why the pool's own candles are shown under a headline price that came from Chainlink. The two
 * reasons are different facts: a thin pool has a price nobody can trade at size, a deviating pool
 * has a price that disagrees with the stock. The old copy said "too thin" for both.
 */
const UNTRUSTED_COPY: Record<"thin" | "deviation", string> = {
  thin: "Chart shows raw DEX pool trades. Liquidity is too thin to trust as a market, so the price shown above is the Chainlink reference — the two can differ a lot until real liquidity arrives.",
  deviation: "Chart shows raw DEX pool trades. The pool price sits too far from the Chainlink reference to be the headline, so the price shown above is the reference — the chart follows the pool and can disagree with it.",
};

export function ChartModule({ address, marketUpdatedAt, referenceUpdatedAt, displayReason = null }: { address: string; marketUpdatedAt?: number | null; referenceUpdatedAt?: number | null; displayReason?: PriceView["displayReason"] }) {
  const [tf, setTf] = useState<Timeframe>("1M");
  const { style, setStyle } = useChartStyle();
  const { data, isLoading, isError, isPlaceholderData } = useChart(address, tf);
  const zone = useTimeZone();
  const candles = data?.candles ?? [];
  const hasVolume = candles.some((c) => c.volume > 0);
  const sourceLabel = data?.source === "reference" ? `Reference · ${timeAgo(referenceUpdatedAt)}` : data?.source === "market" ? `Market · ${timeAgo(marketUpdatedAt)}${hasVolume ? " · volume" : ""}` : "";
  return (
    <div className="flex flex-col">
      {displayReason && data?.source === "market" && <p className="px-4 py-2 border-b border-line text-[12px] text-warning-fg">{UNTRUSTED_COPY[displayReason]}</p>}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-line">
        <div className="flex gap-1" role="tablist" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <Chip key={t} active={tf === t} onClick={() => setTf(t)} className="h-8 min-h-[32px] px-2.5 text-[12px] font-mono">
              {t}
            </Chip>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:block text-[11px] font-mono uppercase tracking-[0.06em] text-ink-muted">
            {sourceLabel}
            {sourceLabel && zone ? <span className="normal-case tracking-normal"> · {zone}</span> : null}
          </div>
          <div className="inline-flex rounded-[6px] border border-line p-0.5" role="group" aria-label="Chart style">
            <button type="button" aria-pressed={style === "line"} onClick={() => setStyle("line")} className={cx("h-7 w-8 inline-flex items-center justify-center rounded-[4px] transition-fast", style === "line" ? "bg-primary text-primary-contrast" : "text-ink-secondary hover:text-ink")} title="Line">
              <TrendingUp size={14} strokeWidth={1.75} />
            </button>
            <button type="button" aria-pressed={style === "candles"} onClick={() => setStyle("candles")} className={cx("h-7 w-8 inline-flex items-center justify-center rounded-[4px] transition-fast", style === "candles" ? "bg-primary text-primary-contrast" : "text-ink-secondary hover:text-ink")} title="Candlesticks">
              <BarChart3 size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
      {/* Below sm the header has no room for the source; a chart without its source is a picture, so it moves under the chips. */}
      {sourceLabel && (
        <div className="sm:hidden px-4 pt-2 text-[11px] font-mono uppercase tracking-[0.06em] text-ink-muted">
          {sourceLabel}
          {zone ? <span className="normal-case tracking-normal"> · {zone}</span> : null}
        </div>
      )}
      {/* A timeframe switch keeps the previous series on screen (dimmed) until the new one arrives. */}
      <div className={cx("px-2 py-2 transition-opacity", isPlaceholderData && "opacity-50")}>
        {isLoading && !data ? <Skeleton className="h-[320px]" /> : isError ? <p className="h-[320px] flex items-center justify-center text-[13px] text-ink-muted">Chart unavailable.</p> : candles.length === 0 ? <p className="h-[320px] flex items-center justify-center text-[13px] text-ink-muted">No chart data for this range yet.</p> : <PriceChart candles={candles} style={style} seriesKey={`${address.toLowerCase()}:${data?.timeframe ?? tf}:${data?.source ?? ""}`} />}
      </div>
    </div>
  );
}

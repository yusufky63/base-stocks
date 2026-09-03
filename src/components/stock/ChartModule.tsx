"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { BarChart3, TrendingUp } from "lucide-react";
import { TIMEFRAMES, type Timeframe } from "@/domain/market";
import { useChart } from "@/hooks/queries";
import { useChartStyle } from "@/hooks/useSettings";
import { Chip, Skeleton, cx } from "@/components/ui/primitives";
import { timeAgo } from "@/lib/format";

const PriceChart = dynamic(() => import("./PriceChart"), { ssr: false, loading: () => <Skeleton className="h-[320px]" /> });

export function ChartModule({ address, marketUpdatedAt, referenceUpdatedAt, marketUntrusted = false }: { address: string; marketUpdatedAt?: number | null; referenceUpdatedAt?: number | null; marketUntrusted?: boolean }) {
  const [tf, setTf] = useState<Timeframe>("1M");
  const { style, setStyle } = useChartStyle();
  const { data, isLoading, isError } = useChart(address, tf);
  const candles = data?.candles ?? [];
  const hasVolume = candles.some((c) => c.volume > 0);
  return (
    <div className="flex flex-col">
      {marketUntrusted && data?.source === "market" && (
        <p className="px-4 py-2 border-b border-line text-[12px] text-warning-fg">Chart shows raw DEX pool trades. Liquidity is too thin to trust as a market, so the price shown above is the Chainlink reference — the two can differ a lot until real liquidity arrives.</p>
      )}
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
            {data?.source === "reference" ? `Reference · ${timeAgo(referenceUpdatedAt)}` : data?.source === "market" ? `Market · ${timeAgo(marketUpdatedAt)}${hasVolume ? " · volume" : ""}` : ""}
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
      <div className="px-2 py-2">
        {isLoading && !data ? <Skeleton className="h-[320px]" /> : isError ? <p className="h-[320px] flex items-center justify-center text-[13px] text-ink-muted">Chart unavailable.</p> : candles.length === 0 ? <p className="h-[320px] flex items-center justify-center text-[13px] text-ink-muted">No chart data for this range yet.</p> : <PriceChart candles={candles} style={style} />}
      </div>
    </div>
  );
}

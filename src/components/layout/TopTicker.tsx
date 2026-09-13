"use client";

import Link from "next/link";
import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { useAssets } from "@/hooks/queries";
import { useNews } from "@/components/news/NewsModule";
import { useTickerSettings } from "@/hooks/useSettings";
import { formatUsd } from "@/lib/format";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { cx } from "@/components/ui/primitives";
import { hasMeaningfulChange, isNotIssued, sortByTradingStatus, tradingStatus } from "@/lib/trading-status";

/**
 * Global marquee rows above the header: prices (on by default) and headlines (opt-in from
 * Settings or the News page). Pure CSS animation, pauses on hover or with the button, honours the
 * Motion setting; data comes from the shared caches so it costs nothing extra per visitor.
 *
 * The strip is decoration over data that Markets and News already present properly, so the moving
 * part is hidden from assistive tech and its links are taken out of the tab order: a screen reader
 * would otherwise read every price twice (the track is duplicated for the seamless loop) and a
 * keyboard user would tab through thirteen moving links before reaching the header. The pause
 * button stays reachable. Each row reserves its height from the first paint, so the header does not
 * jump down when the prices arrive.
 */
export function TopTicker() {
  const { prices: showPrices, news: showNews } = useTickerSettings();
  const [paused, setPaused] = useState(false);
  if (!showPrices && !showNews) return null;
  return (
    <div className={cx("bg-canvas font-mono text-[11px] uppercase tracking-[0.04em] relative", paused && "tape-paused")}>
      <div aria-hidden>
        {showPrices && <PricesRow />}
        {showNews && <NewsRow />}
      </div>
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        aria-label={paused ? "Resume the ticker" : "Pause the ticker"}
        title={paused ? "Resume the ticker" : "Pause the ticker"}
        className="absolute right-1 top-1 h-6 w-6 inline-flex items-center justify-center rounded-[4px] bg-canvas/90 border border-line text-ink-muted hover:text-ink hover:border-line-strong transition-fast"
      >
        {paused ? <Play size={11} strokeWidth={2} /> : <Pause size={11} strokeWidth={2} />}
      </button>
    </div>
  );
}

function Track({ cells, seconds, slow = false }: { cells: React.ReactNode[]; seconds: number; slow?: boolean }) {
  return (
    <div className="tape flex-1">
      <div className={slow ? "tape-track tape-slow" : "tape-track"} style={{ animationDuration: `${seconds}s` }}>
        {cells}
        {cells.map((c, i) => (
          <span key={`dup-${i}`} className="contents">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function PricesRow() {
  // 60s rather than the default 30s: Home shares this query and wants its lists to stay still.
  const { data: assets } = useAssets(undefined, { refetchInterval: 60_000 });
  const prices = sortByTradingStatus((assets?.assets ?? []).map((a) => ({ asset: a, price: assets?.prices[a.canonicalId] })), (x) => x);
  const cells = prices.map(({ asset, price }) => (
    <Link key={asset.canonicalId} href={`/stocks/${asset.address}`} tabIndex={-1} className={`inline-flex items-center gap-2 px-3 h-8 border-r border-line hover:text-primary transition-fast${isNotIssued(asset) ? " opacity-55" : ""}`} title={isNotIssued(asset) ? "Not issued on Base yet" : undefined}>
      <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={16} className="rounded-[3px]" />
      <span className="font-medium">{asset.underlying}</span>
      <span className="num">{formatUsd(price?.displayUsd)}</span>
      <PriceChange value={hasMeaningfulChange(tradingStatus(asset, price).status, price) ? price?.marketChange24hPct : null} digits={1} />
    </Link>
  ));
  return <div className="border-b border-line flex items-stretch min-h-8">{cells.length > 0 && <Track cells={cells} seconds={Math.max(50, cells.length * 5)} />}</div>;
}

function NewsRow() {
  const { data: news } = useNews(undefined, 12);
  const headlines = news?.items ?? [];
  const cells = headlines.map((n, i) => (
    <a key={`${n.id}-${i}`} href={n.url} target="_blank" rel="noreferrer noopener" tabIndex={-1} className="inline-flex items-center gap-2 px-3 h-7 border-r border-line text-ink-secondary hover:text-primary transition-fast max-w-[520px]">
      <span className="text-primary font-medium">{n.ticker}</span>
      <span className="truncate normal-case tracking-normal">{n.title}</span>
      <span className="text-ink-muted">· {n.source}</span>
    </a>
  ));
  return (
    <div className="border-b border-line flex items-stretch min-h-7">
      <Link href="/news" tabIndex={-1} className="hidden sm:flex items-center gap-2 px-3 h-7 border-r border-line text-ink-muted shrink-0 hover:text-primary transition-fast">
        News
      </Link>
      {cells.length > 0 && <Track cells={cells} seconds={Math.max(90, cells.length * 12)} slow />}
    </div>
  );
}

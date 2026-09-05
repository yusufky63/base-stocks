"use client";

import Link from "next/link";
import { useAssets } from "@/hooks/queries";
import { useNews } from "@/components/news/NewsModule";
import { useTickerSettings } from "@/hooks/useSettings";
import { formatUsd } from "@/lib/format";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { hasMeaningfulChange, sortByTradingStatus, tradingStatus } from "@/lib/trading-status";
import { MarketClock } from "./MarketClock";

/**
 * Global marquee rows above the header: prices (on by default) and headlines (opt-in from
 * Settings or the News page). Pure CSS animation, pauses on hover, honours the Motion setting;
 * data comes from the shared caches so it costs nothing extra per visitor.
 */
export function TopTicker() {
  const { prices: showPrices, news: showNews } = useTickerSettings();
  if (!showPrices && !showNews) return null;
  return (
    <div className="bg-canvas font-mono text-[11px] uppercase tracking-[0.04em]">
      {showPrices && <PricesRow />}
      {showNews && <NewsRow />}
    </div>
  );
}

function Track({ cells, seconds, slow = false }: { cells: React.ReactNode[]; seconds: number; slow?: boolean }) {
  return (
    <div className="tape flex-1">
      <div className={slow ? "tape-track tape-slow" : "tape-track"} style={{ animationDuration: `${seconds}s` }}>
        {cells}
        {cells.map((c, i) => (
          <span key={`dup-${i}`} aria-hidden className="contents">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function PricesRow() {
  const { data: assets } = useAssets();
  const prices = sortByTradingStatus((assets?.assets ?? []).map((a) => ({ asset: a, price: assets?.prices[a.canonicalId] })), (x) => x);
  if (prices.length === 0) return null;
  const cells = prices.map(({ asset, price }) => (
    <Link key={asset.canonicalId} href={`/stocks/${asset.address}`} className={`inline-flex items-center gap-2 px-3 h-8 border-r border-line hover:text-primary transition-fast${BigInt(asset.totalSupply ?? "0") === 0n ? " opacity-55" : ""}`} title={BigInt(asset.totalSupply ?? "0") === 0n ? "Not issued on Base yet" : undefined}>
      <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={16} className="rounded-[3px]" />
      <span className="font-medium">{asset.underlying}</span>
      <span className="num">{formatUsd(price?.displayUsd)}</span>
      <PriceChange value={hasMeaningfulChange(tradingStatus(asset, price).status, price) ? price?.marketChange24hPct : null} digits={1} />
    </Link>
  ));
  return (
    <div className="border-b border-line flex items-stretch">
      <MarketClock className="hidden sm:inline-flex" />
      <Track cells={cells} seconds={Math.max(50, cells.length * 5)} />
    </div>
  );
}

function NewsRow() {
  const { data: news } = useNews(undefined, 12);
  const headlines = news?.items ?? [];
  if (headlines.length === 0) return null;
  const cells = headlines.map((n, i) => (
    <a key={`${n.id}-${i}`} href={n.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-2 px-3 h-7 border-r border-line text-ink-secondary hover:text-primary transition-fast max-w-[520px]">
      <span className="text-primary font-medium">{n.ticker}</span>
      <span className="truncate normal-case tracking-normal">{n.title}</span>
      <span className="text-ink-muted">· {n.source}</span>
    </a>
  ));
  return (
    <div className="border-b border-line flex items-stretch">
      <Link href="/news" className="hidden sm:flex items-center gap-2 px-3 h-7 border-r border-line text-ink-muted shrink-0 hover:text-primary transition-fast">
        News
      </Link>
      <Track cells={cells} seconds={Math.max(90, cells.length * 12)} slow />
    </div>
  );
}

"use client";

import { ArrowUpRight } from "lucide-react";
import { Coin3D } from "@/components/common/Coin3D";
import { PriceChange } from "@/components/common/display";
import { TradePanel } from "@/components/trade/TradePanel";
import { Module } from "@/components/ui/primitives";
import { useAsset } from "@/hooks/queries";
import type { AssetResponse } from "@/lib/client-api";
import { APP_URL, type EmbedSide } from "@/lib/embed";
import { formatUsd } from "@/lib/format";
import { hasMeaningfulChange, isNotIssued, tradingStatus } from "@/lib/trading-status";
import { useEmbedHidden } from "./EmbedOptions";
import { postToHost } from "./EmbedShell";

/**
 * The trade widget: one stock's buy / sell panel, the site's own, with the same live quote, route,
 * review step and eligibility question. The trade goes from the visitor's wallet to the route the
 * quote names; the host never touches it.
 */
export function TradeWidget({ address, initialData, initialSide = "buy" }: { address: string; initialData: AssetResponse; initialSide?: EmbedSide }) {
  const { data } = useAsset(address, initialData);
  const { asset, price } = data ?? initialData;
  const hidden = useEmbedHidden();

  return (
    <Module ticks>
      {!hidden("header") && <StockHeader data={data ?? initialData} />}
      <TradePanel asset={asset} price={price} initialSide={initialSide} onTraded={({ side, txHash }) => postToHost({ type: "trade", asset: asset.address.toLowerCase(), side, txHash })} />
    </Module>
  );
}

/** Name, price and the daily move, with a way out to the full stock page. Shared with the stock widget. */
export function StockHeader({ data, large = false }: { data: AssetResponse; large?: boolean }) {
  const { asset, price } = data;
  const status = tradingStatus(asset, price);
  const change24h = hasMeaningfulChange(status.status, price) ? (price?.marketChange24hPct ?? null) : null;
  const displayPrice = price?.displayUsd ?? null;
  return (
    <div className="flex items-center gap-3 p-3 border-b border-line">
      <Coin3D underlying={asset.underlying} symbol={asset.symbol} fallbackSrc={asset.logoURI} size={large ? 48 : 40} muted={isNotIssued(asset)} tilt={false} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="display text-[18px] leading-tight truncate">{asset.name}</span>
          <span className="font-mono text-[12px] text-ink-muted shrink-0">{asset.symbol}</span>
        </div>
        <div className="flex items-baseline gap-2 mt-1 flex-wrap">
          <span className={large ? "display num text-[28px] leading-none" : "font-mono num text-[13px] text-ink-secondary"}>{displayPrice === null ? "—" : formatUsd(displayPrice)}</span>
          <PriceChange value={change24h} className={large ? "text-[14px]" : "text-[12px]"} />
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">{price?.displaySource === "reference" ? (price.referenceSource === "equity-market" ? "share price" : "reference") : price?.displaySource === "market" ? "market" : ""}</span>
        </div>
      </div>
      <a
        href={`${APP_URL}/stocks/${asset.address}`}
        target="_blank"
        rel="noreferrer noopener"
        aria-label="Open the full stock page"
        title={`${asset.underlying} on BStocks: chart, liquidity and news`}
        className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-[6px] border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast"
      >
        <ArrowUpRight size={15} strokeWidth={1.75} />
      </a>
    </div>
  );
}

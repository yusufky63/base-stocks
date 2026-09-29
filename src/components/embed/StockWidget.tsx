"use client";

import { useRouter } from "next/navigation";
import { ChartModule } from "@/components/stock/ChartModule";
import { Button, KeyValue, Module } from "@/components/ui/primitives";
import { useAsset } from "@/hooks/queries";
import type { AssetResponse } from "@/lib/client-api";
import { withEmbedParams, type EmbedSide } from "@/lib/embed";
import type { Timeframe } from "@/domain/market";
import { formatUsdCompact } from "@/lib/format";
import { isNotIssued, tradingStatus } from "@/lib/trading-status";
import { useEmbedHidden } from "./EmbedOptions";
import { StockHeader } from "./TradeWidget";

/**
 * The stock widget: a stock's price, its daily move, the chart and the market behind it, refreshed
 * the way the stock page refreshes. Buy and Sell hand over to the trade widget inside the same
 * frame, with the host's theme, colour and choices carried along.
 */
export function StockWidget({ address, initialData, range = "1M" }: { address: string; initialData: AssetResponse; range?: Timeframe }) {
  const router = useRouter();
  const { data } = useAsset(address, initialData);
  const view = data ?? initialData;
  const { asset, price } = view;
  const hidden = useEmbedHidden();
  const status = tradingStatus(asset, price);
  const trade = (side: EmbedSide) => router.push(withEmbedParams(`/embed/trade/${asset.address.toLowerCase()}${side === "sell" ? "?side=sell" : ""}`, window.location.search));

  return (
    <Module ticks>
      <StockHeader data={view} large />
      {!hidden("chart") && (
        <ChartModule
          address={asset.address}
          marketUpdatedAt={price?.marketUpdatedAt}
          referenceUpdatedAt={price?.referenceUpdatedAt}
          displayReason={price?.displayReason ?? null}
          initialTimeframe={range}
          timeframes={!hidden("range")}
        />
      )}
      {!hidden("stats") && (
        <div className="px-4 py-3 border-t border-line">
          <KeyValue k="Status" v={<span title={status.detail}>{status.label}</span>} mono={false} />
          <KeyValue k="Market cap" v={formatUsdCompact(price?.marketCapUsd ?? null)} />
          <KeyValue k="Pool liquidity" v={formatUsdCompact(price?.liquidityUsd ?? null)} />
          <KeyValue k="Volume 24h" v={formatUsdCompact(price?.volume24hUsd ?? null)} />
        </div>
      )}
      {!hidden("trade") && (
        <div className="p-3 border-t border-line grid grid-cols-2 gap-2">
          <Button full variant="primary" disabled={isNotIssued(asset)} onClick={() => trade("buy")}>
            Buy {asset.underlying}
          </Button>
          <Button full variant="ink" disabled={isNotIssued(asset)} onClick={() => trade("sell")}>
            Sell
          </Button>
        </div>
      )}
    </Module>
  );
}

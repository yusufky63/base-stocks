"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import type { Address } from "viem";
import type { AssetResponse, LpPositionDTO } from "@/lib/client-api";
import type { TradeSide } from "@/domain/trade";
import { useAsset, useWatchlist, usePortfolio, useLpPositions, qk } from "@/hooks/queries";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { formatUsd } from "@/lib/format";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { Coin3D } from "@/components/common/Coin3D";
import { TimeAgo } from "@/components/common/TimeAgo";
import { Badge, Button, Module, cx } from "@/components/ui/primitives";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Sheet } from "@/components/ui/Sheet";
import { StickyPanel } from "@/components/ui/StickyPanel";
import { ChartModule } from "./ChartModule";
import { AssetDetails } from "./AssetDetails";
import { PositionModule, type LpSummary } from "./PositionModule";
import { TradesModule } from "./TradesModule";
import { OrdersModule } from "@/components/trade/OrdersModule";
import { CorporateActionsModule } from "./CorporateActionsModule";
import { TradePanel } from "@/components/trade/TradePanel";
import { SendSheet } from "@/components/gift/SendSheet";
import { EarnModule } from "@/components/earn/EarnModule";
import { ShareButton } from "@/components/common/ShareSheet";

/**
 * Stock detail (spec §44). Desktop: chart + trade panel side by side. Mobile: chart first,
 * position, contextual sections, sticky BUY / SELL bottom action opening the trade sheet.
 */
export function StockDetailView({ initialData }: { initialData: AssetResponse }) {
  const { address: user } = useAccount();
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const { data } = useAsset(initialData.asset.address, initialData);
  const asset = data?.asset ?? initialData.asset;
  const price = data?.price ?? initialData.price;
  const balances = useTokenBalances(user, asset.address as Address);
  const watchlist = useWatchlist(user);
  const { data: portfolio } = usePortfolio(user);
  const lpQuery = useLpPositions(user);
  const lp = useMemo(() => summarizeLp(lpQuery.data?.positions ?? [], asset.address), [lpQuery.data, asset.address]);
  const isDesktop = useIsDesktop();

  const tradeParam = search.get("trade");
  const [side, setSide] = useState<TradeSide>(tradeParam === "sell" ? "sell" : "buy");
  const [mobileTrade, setMobileTrade] = useState(!!tradeParam);
  const [sendOpen, setSendOpen] = useState(false);
  const [tab, setTab] = useState<"position" | "earn" | "details">("position");
  const [seenParam, setSeenParam] = useState(tradeParam);
  if (tradeParam !== seenParam) {
    setSeenParam(tradeParam);
    if (tradeParam === "buy" || tradeParam === "sell") {
      setSide(tradeParam);
      setMobileTrade(true);
    }
  }

  const closeMobileTrade = () => {
    setMobileTrade(false);
    if (search.get("trade")) router.replace(`/stocks/${asset.address}`);
  };

  const onTraded = () => {
    balances.refetch();
    qc.invalidateQueries({ queryKey: qk.portfolio(user ?? "") });
    qc.invalidateQueries({ queryKey: qk.activity(user ?? "") });
  };

  const displayPrice = price?.displayUsd ?? null;
  const watched = watchlist.has(asset.address);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Module ticks>
            <div className="p-4 md:p-5 flex items-start justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <Coin3D underlying={asset.underlying} symbol={asset.symbol} fallbackSrc={asset.logoURI} size={64} float muted={BigInt(asset.totalSupply ?? "0") === 0n} />
                <div className="min-w-0">
                  <div className="eyebrow mb-1">
                    {asset.underlying} · Coinbase Tokenized Stock
                  </div>
                  <h1 className="display text-[26px] md:text-[32px] leading-tight truncate">
                    {asset.name} <span className="text-ink-muted font-mono text-[13px] tracking-normal font-normal">{asset.symbol}</span>
                  </h1>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {asset.status === "paused" && <Badge tone="danger">Transfers paused</Badge>}
                    {BigInt(asset.totalSupply ?? "0") === 0n && <Badge tone="warning">Not issued onchain yet</Badge>}
                    {asset.oracle?.paused && <Badge tone="warning">Corporate action</Badge>}
                    {asset.pendingMultiplier && <Badge tone="warning">Multiplier change scheduled</Badge>}
                    {price?.displaySource === "reference" && <Badge>Reference price</Badge>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ShareButton iconOnly path={`/stocks/${asset.address}`} text={`${asset.underlying} as a tokenized stock on Base. Trade it self-custodially on BStocks.`} title={`Share ${asset.underlying}`} />
                {user && (
                  <button type="button" aria-label={watched ? "Remove from watchlist" : "Add to watchlist"} aria-pressed={watched} onClick={() => watchlist.toggle(asset.address as Address)} className={cx("h-9 w-9 inline-flex items-center justify-center rounded-[6px] border transition-fast", watched ? "text-primary border-primary bg-primary-soft" : "text-ink-muted border-line hover:border-line-strong hover:text-ink")}>
                    <Star size={16} strokeWidth={1.75} fill={watched ? "currentColor" : "none"} />
                  </button>
                )}
              </div>
            </div>
            <div className="px-4 md:px-5 pb-4 flex items-baseline gap-3 flex-wrap">
              <span className="display num text-[44px] md:text-[60px] leading-none">
                <AnimatedNumber value={displayPrice} format={(v) => formatUsd(v)} />
              </span>
              <PriceChange value={price?.marketChange24hPct} className="text-[16px]" />
              <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
                {price?.displaySource === "market" ? (
                  <>
                    market · <TimeAgo value={price.marketUpdatedAt} />
                  </>
                ) : price?.displaySource === "reference" ? (
                  <>
                    reference · <TimeAgo value={price.referenceUpdatedAt} />
                  </>
                ) : (
                  ""
                )}
              </span>
            </div>
            <div className="border-t border-line">
              <ChartModule address={asset.address} marketUpdatedAt={price?.marketUpdatedAt} referenceUpdatedAt={price?.referenceUpdatedAt} />
            </div>
          </Module>

          <Module>
            <div role="tablist" aria-label="Stock sections" className="grid grid-cols-3 border-b border-line">
              {(
                [
                  ["position", "Your position"],
                  ["earn", "Earn or borrow"],
                  ["details", "Details"],
                ] as const
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx("relative h-11 text-[13px] font-medium transition-fast", tab === id ? "text-primary after:absolute after:left-0 after:right-0 after:-bottom-px after:h-[2px] after:bg-primary" : "text-ink-secondary hover:text-ink")}>
                  {label}
                </button>
              ))}
            </div>
            {tab === "position" && (
              <>
              <PositionModule
                asset={asset}
                raw={balances.raw}
                scaled={balances.scaled}
                priceUsd={displayPrice}
                change24hPct={price?.marketChange24hPct ?? null}
                portfolioWeightBps={portfolio?.holdings.find((h) => h.assetAddress.toLowerCase() === asset.canonicalId)?.currentWeightBps}
                connected={!!user}
                onBuy={() => { setSide("buy"); setMobileTrade(true); }}
                onSell={() => { setSide("sell"); setMobileTrade(true); }}
                onSend={() => setSendOpen(true)}
                lp={lp}
              />
              <OrdersModule owner={user} assetAddress={asset.address as Address} />
              <TradesModule asset={asset} user={user} />
              </>
            )}
            {tab === "earn" && <EarnModule assetAddress={asset.address as Address} user={user} symbol={asset.underlying} showEmpty />}
            {tab === "details" && (
              <>
                <div className="p-4 border-b border-line [&:empty]:hidden">
                  <CorporateActionsModule asset={asset} />
                </div>
                <AssetDetails asset={asset} price={price} />
              </>
            )}
          </Module>
        </div>

        {isDesktop && (
          <StickyPanel>
            <Module ticks>
              <TradePanel asset={asset} price={price} initialSide={side} onTraded={onTraded} />
            </Module>
          </StickyPanel>
        )}
      </div>

      {!isDesktop && (
        <>
          <div className="fixed inset-x-0 bottom-14 z-20 border-t border-line bg-canvas px-4 py-2 grid grid-cols-2 gap-2 [padding-bottom:calc(8px+env(safe-area-inset-bottom))]">
            <Button size="lg" onClick={() => { setSide("buy"); setMobileTrade(true); }} disabled={asset.status === "paused"}>
              Buy
            </Button>
            <Button size="lg" variant="secondary" onClick={() => { setSide("sell"); setMobileTrade(true); }} disabled={asset.status === "paused"}>
              Sell
            </Button>
          </div>
          <Sheet open={mobileTrade} onClose={closeMobileTrade} title={`${asset.underlying}`} wide>
            <div className="-mx-5 -my-4">
              <TradePanel asset={asset} price={price} initialSide={side} onTraded={onTraded} />
            </div>
          </Sheet>
        </>
      )}

      <SendSheet open={sendOpen} onClose={() => setSendOpen(false)} asset={asset} raw={balances.raw} scaled={balances.scaled} priceUsd={displayPrice} onSent={onTraded} />
    </div>
  );
}

/** Aggregate this wallet's LP positions that contain the stock into one line for the position card. */
function summarizeLp(positions: LpPositionDTO[], asset: string): LpSummary | null {
  const a = asset.toLowerCase();
  const mine = positions.filter((p) => p.token0.address.toLowerCase() === a || p.token1.address.toLowerCase() === a);
  if (mine.length === 0) return null;
  let stockAmount = 0;
  let valueUsd = 0;
  let feesUsd = 0;
  let inRange = 0;
  let hasValue = false;
  const quotes = new Map<string, number>();
  for (const p of mine) {
    const stockIs0 = p.token0.address.toLowerCase() === a;
    stockAmount += stockIs0 ? p.amount0 : p.amount1;
    const quote = stockIs0 ? p.token1 : p.token0;
    quotes.set(quote.symbol, (quotes.get(quote.symbol) ?? 0) + (stockIs0 ? p.amount1 : p.amount0));
    if (p.valueUsd !== null) {
      valueUsd += p.valueUsd;
      hasValue = true;
    }
    if (p.fees.usd) feesUsd += p.fees.usd;
    if (p.inRange) inRange += 1;
  }
  const quoteText = [...quotes.entries()].map(([symbol, n]) => `${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 })} ${symbol}`).join(" + ");
  return { count: mine.length, stockAmount, quoteText, valueUsd: hasValue ? valueUsd : null, feesUsd: feesUsd || null, inRange };
}

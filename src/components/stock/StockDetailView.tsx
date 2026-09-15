"use client";

import { useCallback, useMemo, useRef, useState, Suspense, type KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAccount, useConnect } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import type { Address } from "viem";
import type { AssetResponse, LpPositionDTO } from "@/lib/client-api";
import type { TradeSide } from "@/domain/trade";
import { useAsset, useWatchlist, usePortfolio, useLpPositions, qk } from "@/hooks/queries";
import { useTokenBalances } from "@/hooks/useTokenBalances";
import { formatUsd } from "@/lib/format";
import { PriceChange } from "@/components/common/display";
import { TimeAgo } from "@/components/common/TimeAgo";
import { Badge, Button, Module, Skeleton, cx } from "@/components/ui/primitives";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Sheet } from "@/components/ui/Sheet";
import { StickyPanel } from "@/components/ui/StickyPanel";
import { ChartModule } from "./ChartModule";
import { AssetDetails } from "./AssetDetails";
import { PositionModule, type LpSummary } from "./PositionModule";
import { TradesModule } from "./TradesModule";
import { OrdersModule } from "@/components/trade/OrdersModule";
import { PoolsModule } from "./PoolsModule";
import { LaunchpadModule } from "./LaunchpadModule";
import { PlatformActivity } from "./PlatformActivity";
import { TradePanel } from "@/components/trade/TradePanel";
import { SendSheet } from "@/components/gift/SendSheet";
import { EarnModule } from "@/components/earn/EarnModule";
import { NewsList, useNewsFeed } from "@/components/news/NewsModule";
import { ShareButton } from "@/components/common/ShareSheet";
import { Coin3D } from "@/components/fx/lazy";
import { hasMeaningfulChange, isNotIssued, tradingStatus } from "@/lib/trading-status";
import { TradeParam, type StockParams } from "./TradeParam";
import { ensureAppKit, getAppKit } from "@/config/appkit";
import { hasReown, MINI_APP_CONNECTOR_ID } from "@/config/wagmi";
import { BASE_CHAIN_ID } from "@/config/chain";
import { useMiniApp } from "@/components/layout/MiniAppProvider";
import { useTheme } from "@/components/layout/ThemeProvider";

const TABS = [
  ["position", "Position"],
  ["trades", "Trades"],
  ["orders", "Orders"],
  ["earn", "Earn"],
  ["news", "News"],
  ["details", "Details"],
] as const;
type Tab = (typeof TABS)[number][0];
const isTab = (v: string | null): v is Tab => TABS.some(([id]) => id === v);

/** The desktop layout is CSS (`lg:`); this only decides whether a click should open the mobile sheet, so it is read at click time. */
const isDesktopViewport = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;

/**
 * The same entry point the header's Connect button uses, for a control that is shown before a
 * wallet is connected (the watchlist star): the host wallet in the Base app, the AppKit modal when
 * configured, otherwise the first connector.
 */
function useOpenConnect() {
  const { connectors, connect } = useConnect();
  const { isMiniApp } = useMiniApp();
  const { resolved: theme } = useTheme();
  return useCallback(() => {
    if (isMiniApp) {
      const host = connectors.find((c) => c.id === MINI_APP_CONNECTOR_ID);
      if (host) {
        connect({ connector: host, chainId: BASE_CHAIN_ID });
        return;
      }
    }
    if (hasReown) {
      void (getAppKit() ? Promise.resolve(getAppKit()) : ensureAppKit(theme)).then((kit) => kit?.open());
      return;
    }
    const first = connectors[0];
    if (first) connect({ connector: first, chainId: BASE_CHAIN_ID });
  }, [connectors, connect, isMiniApp, theme]);
}

/**
 * One line about the issuer's price feed when it is not simply live. The feed holds its last value
 * outside US trading hours and during corporate actions; without saying so, a price that has not
 * moved since Friday reads as a broken page on a Sunday.
 */
function feedNote(asset: AssetResponse["asset"], referenceUpdatedAt: number | null | undefined): string | null {
  const freshness = asset.oracle?.freshness;
  if (!freshness || freshness === "live") return null;
  if (freshness === "frozen") return "Corporate action in progress: the issuer's price feed is frozen until it completes.";
  if (freshness === "last-close") {
    const day = referenceUpdatedAt ? new Date(referenceUpdatedAt).toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" }) : null;
    return `US market closed; the issuer's feed holds ${day ? `${day}'s` : "the last"} close.`;
  }
  return "The issuer's price feed has not updated for over a day.";
}

/**
 * Stock detail (spec §44). Desktop: chart + trade panel side by side. Mobile: chart first,
 * position, contextual sections, sticky BUY / SELL bottom action opening the trade sheet.
 *
 * The split is CSS (`hidden lg:block` / `lg:hidden`), not a media-query hook: the hook answered
 * "not desktop" on the server, so a desktop visitor hydrated into the mobile layout and watched
 * the page rearrange itself. The trade panel is mounted once on desktop; the mobile sheet mounts
 * its own copy only while it is open.
 */
export function StockDetailView({ initialData }: { initialData: AssetResponse }) {
  const { address: user } = useAccount();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { data } = useAsset(initialData.asset.address, initialData);
  const asset = data?.asset ?? initialData.asset;
  const price = data?.price ?? initialData.price;
  const balances = useTokenBalances(user, asset.address as Address);
  const watchlist = useWatchlist(user);
  const { data: portfolio } = usePortfolio(user);
  const lpQuery = useLpPositions(user);
  const lp = useMemo(() => summarizeLp(lpQuery.data?.positions ?? [], asset.address), [lpQuery.data, asset.address]);
  const openConnect = useOpenConnect();

  const [side, setSide] = useState<TradeSide>("buy");
  const [mobileTrade, setMobileTrade] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("position");
  const [hadTradeParam, setHadTradeParam] = useState(false);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const openTrade = useCallback((s: TradeSide) => {
    setSide(s);
    if (!isDesktopViewport()) setMobileTrade(true);
  }, []);

  // `?trade=` and `?tab=` arrive from a leaf component after hydration (see TradeParam), so the page itself prerenders.
  const onParams = useCallback(
    ({ trade, tab: tabParam }: StockParams) => {
      if (isTab(tabParam)) setTab(tabParam);
      if (trade === "buy" || trade === "sell") {
        setHadTradeParam(true);
        openTrade(trade);
      }
    },
    [openTrade],
  );

  /** The tab lives in the URL so a section can be linked and survives a reload. */
  const selectTab = (id: Tab) => {
    setTab(id);
    router.replace(id === "position" ? pathname : `${pathname}?tab=${id}`, { scroll: false });
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const ids = TABS.map(([id]) => id);
    const i = ids.indexOf(tab);
    let next: Tab | null = null;
    if (e.key === "ArrowRight") next = ids[(i + 1) % ids.length]!;
    else if (e.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length]!;
    else if (e.key === "Home") next = ids[0]!;
    else if (e.key === "End") next = ids[ids.length - 1]!;
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const closeMobileTrade = () => {
    setMobileTrade(false);
    if (hadTradeParam) {
      setHadTradeParam(false);
      router.replace(tab === "position" ? pathname : `${pathname}?tab=${tab}`, { scroll: false });
    }
  };

  const onTraded = () => {
    balances.refetch();
    qc.invalidateQueries({ queryKey: qk.portfolio(user ?? "") });
    qc.invalidateQueries({ queryKey: qk.activity(user ?? "") });
  };

  const displayPrice = price?.displayUsd ?? null;
  const watched = watchlist.has(asset.address);
  const status = tradingStatus(asset, price);
  // A daily move is asserted only by a market deep enough for it to be about the stock, not about one trade.
  const meaningfulChange = hasMeaningfulChange(status.status, price);
  const change24h = meaningfulChange ? (price?.marketChange24hPct ?? null) : null;
  const note = feedNote(asset, price?.referenceUpdatedAt);
  const reasonText = price?.displayReason === "thin" ? "pool too thin to price" : price?.displayReason === "deviation" ? "pool price off the reference" : null;

  return (
    <div className="flex flex-col gap-5 pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0">
      <Suspense fallback={null}>
        <TradeParam onChange={onParams} />
      </Suspense>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Module ticks>
            <div className="p-4 md:p-5 flex items-start justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <Coin3D underlying={asset.underlying} symbol={asset.symbol} fallbackSrc={asset.logoURI} size={64} float muted={isNotIssued(asset)} />
                <div className="min-w-0">
                  <div className="eyebrow mb-1">
                    {asset.underlying} · Coinbase Tokenized Stock
                  </div>
                  <h1 className="display text-[26px] md:text-[32px] leading-tight truncate">
                    {asset.name} <span className="text-ink-muted font-mono text-[13px] tracking-normal font-normal">{asset.symbol}</span>
                  </h1>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {/* The same Live / Thin / No pool / Not issued / Paused the Markets table shows, with the depth behind it on hover. */}
                    <span title={status.detail}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </span>
                    {asset.oracle?.paused && <Badge tone="warning">Corporate action</Badge>}
                    {asset.pendingMultiplier && <Badge tone="warning">Multiplier change scheduled</Badge>}
                    {price?.displaySource === "reference" && (
                      <span className="inline-flex items-center gap-1.5">
                        <Badge>Reference price</Badge>
                        {reasonText && <span className="font-mono text-[11px] text-ink-muted">{reasonText}</span>}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ShareButton iconOnly path={`/stocks/${asset.address}`} text={`${asset.underlying} as a tokenized stock on Base. Trade it self-custodially on BaseStocks.`} title={`Share ${asset.underlying}`} />
                {/* Shown before a wallet is connected too: the star is how a visitor learns the watchlist exists, and the click connects. */}
                <button
                  type="button"
                  aria-label={!user ? "Connect a wallet to add to your watchlist" : watched ? "Remove from watchlist" : "Add to watchlist"}
                  aria-pressed={!!user && watched}
                  onClick={() => (user ? watchlist.toggle(asset.address as Address) : openConnect())}
                  className={cx("h-9 w-9 inline-flex items-center justify-center rounded-[6px] border transition-fast", user && watched ? "text-primary border-primary bg-primary-soft" : "text-ink-muted border-line hover:border-line-strong hover:text-ink")}
                >
                  <Star size={16} strokeWidth={1.75} fill={user && watched ? "currentColor" : "none"} />
                </button>
              </div>
            </div>
            <div className="px-4 md:px-5 pb-4 flex items-baseline gap-3 flex-wrap">
              <span className="display num text-[44px] md:text-[60px] leading-none">
                {/* The tween keeps its last number when the value goes away; "—" is the honest state. */}
                {displayPrice === null ? "—" : <AnimatedNumber value={displayPrice} format={(v) => formatUsd(v)} />}
              </span>
              <PriceChange value={change24h} className="text-[16px]" />
              {change24h === null && price?.marketChange24hPct !== null && price?.marketChange24hPct !== undefined && (
                <span className="font-mono text-[11px] text-ink-muted" title={status.detail}>
                  24h move not shown: market too thin to credit it to the stock
                </span>
              )}
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
            {note && <p className="px-4 md:px-5 pb-3 -mt-1 text-[12px] text-ink-secondary">{note}</p>}
            <div className="border-t border-line">
              <ChartModule address={asset.address} marketUpdatedAt={price?.marketUpdatedAt} referenceUpdatedAt={price?.referenceUpdatedAt} displayReason={price?.displayReason ?? null} />
            </div>
          </Module>

          <Module>
            <div role="tablist" aria-label="Stock sections" aria-orientation="horizontal" onKeyDown={onTabKey} className="grid grid-cols-6 border-b border-line">
              {TABS.map(([id, label]) => (
                <button
                  key={id}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  id={`stock-tab-${id}`}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={`stock-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => selectTab(id)}
                  className={cx("relative h-11 text-[12px] md:text-[13px] font-medium transition-fast", tab === id ? "text-primary after:absolute after:left-0 after:right-0 after:-bottom-px after:h-[2px] after:bg-primary" : "text-ink-secondary hover:text-ink")}
                >
                  {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`stock-panel-${tab}`} aria-labelledby={`stock-tab-${tab}`}>
              {tab === "position" && (
                <PositionModule
                  asset={asset}
                  raw={balances.raw}
                  scaled={balances.scaled}
                  priceUsd={displayPrice}
                  change24hPct={change24h}
                  portfolioWeightBps={portfolio?.holdings.find((h) => h.assetAddress.toLowerCase() === asset.canonicalId)?.currentWeightBps}
                  connected={!!user}
                  onBuy={() => openTrade("buy")}
                  onSend={() => setSendOpen(true)}
                  lp={lp}
                />
              )}
              {tab === "trades" && <TradesModule asset={asset} user={user} />}
              {tab === "trades" && !user && <p className="px-4 py-4 text-[14px] text-ink-secondary">Connect a wallet to see your trades for this stock.</p>}
              {tab === "orders" && <OrdersModule owner={user} assetAddress={asset.address as Address} title="Your orders" showEmpty />}
              {tab === "orders" && !user && <p className="px-4 py-4 text-[14px] text-ink-secondary">Connect a wallet to see your limit orders for this stock.</p>}
              {tab === "earn" && (
                <>
                  <EarnModule assetAddress={asset.address as Address} user={user} symbol={asset.underlying} showEmpty />
                  <div className="border-t border-line px-4 py-3">
                    <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-2">Liquidity pools</div>
                    <PoolsModule address={asset.address as Address} />
                  </div>
                </>
              )}
              {tab === "news" && <StockNews ticker={asset.underlying} />}
              {tab === "details" && (
                <>
                  <div className="p-4 border-b border-line">
                    <PlatformActivity assetAddress={asset.address} underlying={asset.underlying} />
                  </div>
                  <LaunchpadModule stockAddress={asset.address} underlying={asset.underlying} />
                  <AssetDetails asset={asset} price={price} />
                </>
              )}
            </div>
          </Module>
        </div>

        <div className="hidden lg:block">
          <StickyPanel>
            <Module ticks>
              <TradePanel asset={asset} price={price} initialSide={side} onTraded={onTraded} />
            </Module>
          </StickyPanel>
        </div>
      </div>

      <div className="lg:hidden fixed inset-x-0 bottom-14 z-20 border-t border-line bg-canvas px-4 py-2 grid grid-cols-2 gap-2 [padding-bottom:calc(8px+env(safe-area-inset-bottom))]">
        <Button size="lg" onClick={() => openTrade("buy")} disabled={asset.status === "paused"}>
          Buy
        </Button>
        <Button size="lg" variant="secondary" onClick={() => openTrade("sell")} disabled={asset.status === "paused"}>
          Sell
        </Button>
      </div>
      {/* Mounted only while open, so the panel exists once at a time: the desktop column or this sheet. */}
      {mobileTrade && (
        <div className="lg:hidden">
          <Sheet open onClose={closeMobileTrade} title={`${asset.underlying}`} wide>
            <div className="-mx-5 -my-4">
              <TradePanel asset={asset} price={price} initialSide={side} onTraded={onTraded} />
            </div>
          </Sheet>
        </div>
      )}

      <SendSheet open={sendOpen} onClose={() => setSendOpen(false)} asset={asset} raw={balances.raw} scaled={balances.scaled} priceUsd={displayPrice} onSent={onTraded} />
    </div>
  );
}

/**
 * Headlines about this stock: the News page's per-ticker feed (Google News, Yahoo Finance, Nasdaq,
 * Seeking Alpha), inside the tab rather than in its own card. Links open at the publisher.
 */
function StockNews({ ticker }: { ticker: string }) {
  const { data, isLoading } = useNewsFeed({ ticker }, 12);
  return (
    <div>
      {isLoading && !data ? (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <NewsList items={data?.items ?? []} />
      )}
      <div className="px-4 py-2.5 border-t border-line flex items-center justify-between gap-3 text-[11px] text-ink-muted">
        <span>Headlines from multiple publishers; links open at the source. Not investment advice.</span>
        <Link href="/news" className="text-primary font-medium shrink-0">
          All news →
        </Link>
      </div>
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

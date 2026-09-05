"use client";

import { useMemo } from "react";
import Link from "next/link";
import { hasMeaningfulChange, sortByTradingStatus, tradingStatus } from "@/lib/trading-status";
import { GiftsCard } from "@/components/pool/PoolList";
import { useAccount } from "wagmi";
import { ArrowRight, Search, BookOpen, ShoppingCart, Wallet, Layers, Send } from "lucide-react";
import { useAssets, useActivity, useCommunityPulse, usePortfolio, useTemplates, useWatchlist, useSparklines, useStats } from "@/hooks/queries";
import type { AssetsResponse } from "@/lib/client-api";
import type { PortfolioTemplate } from "@/domain/portfolio";
import { formatUsd, bpsToPct, formatUsdCompact, timeAgo } from "@/lib/format";
import { sortTemplatesByLiveness, templateLiveness } from "@/lib/templates";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { hasCoin } from "@/lib/coins";
import { AllocationBar } from "@/components/common/AllocationBar";
import { LinkButton, Module, ModuleHeader, Skeleton, Stat, Badge } from "@/components/ui/primitives";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Sparkline } from "@/components/ui/Sparkline";
import { ActivityList } from "@/components/activity/ActivityList";
import { PublicFeed } from "@/components/activity/PublicFeed";
import { NewsModule } from "@/components/news/NewsModule";
import { FundWallet } from "@/components/common/FundWallet";
import { Coin3D, Dither } from "@/components/fx/lazy";

export function HomeView({ initialAssets, initialTemplates }: { initialAssets?: AssetsResponse; initialTemplates?: PortfolioTemplate[] }) {
  const { address, isConnected } = useAccount();
  // Home opts out of the 30s price poll: the movers list should stay still, not reshuffle under the reader.
  const { data: assets } = useAssets(initialAssets, { refetchInterval: false });
  const { data: portfolio, isLoading: loadingPortfolio } = usePortfolio(address);
  const { data: templates } = useTemplates(initialTemplates);
  const { data: activity } = useActivity(address);
  const { data: sparks } = useSparklines();
  const watchlist = useWatchlist(address);

  // Derived once per assets change, so the portfolio's own refetch cannot re-sort or re-animate the lists.
  const priced = useMemo(() => (assets?.assets ?? []).map((a) => ({ asset: a, price: assets?.prices[a.canonicalId] })), [assets]);
  const ordered = useMemo(() => sortByTradingStatus(priced, (x) => x), [priced]);
  const movers = useMemo(
    () =>
      ordered
        .filter((x) => hasMeaningfulChange(tradingStatus(x.asset, x.price).status, x.price))
        .sort((a, b) => Math.abs(b.price?.marketChange24hPct ?? 0) - Math.abs(a.price?.marketChange24hPct ?? 0))
        .slice(0, 6),
    [ordered],
  );
  const watched = useMemo(() => priced.filter(({ asset }) => watchlist.has(asset.address)), [priced, watchlist]);
  const quick = useMemo(() => ordered.slice(0, 4), [ordered]);

  return (
    <div className="flex flex-col gap-6">
      <section className="hero-fx border border-line rounded-[8px] ticks overflow-hidden bg-canvas">
        <Dither className="fx-layer" pixelSize={5} opacity={0.2} speed={0.25} mouseRadius={120} />
        {/* Readability scrim: solid canvas under the copy, dots fading in toward the coins. */}
        <div aria-hidden className="fx-layer pointer-events-none absolute inset-0 bg-gradient-to-r from-canvas from-20% via-canvas/70 via-60% to-transparent" />
        <div className="fx-content p-6 md:p-12 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-8 items-center">
          <div className="reveal">
            <div className="eyebrow mb-4">01 — Built on Base</div>
            <h1 className="display text-[44px] md:text-[76px] leading-[0.92]">
              Stocks,
              <br />
              built for <span className="text-primary">onchain</span>.
            </h1>
            <p className="mt-5 max-w-[52ch] text-[15px] md:text-[17px] text-ink-secondary">Trade Coinbase Tokenized Stocks, build a personalized basket, put idle USDC to work, and keep everything in your own wallet.</p>
            <div className="mt-7 flex flex-col sm:flex-row gap-2">
              <LinkButton href="/markets" variant="primary" size="lg">
                Browse markets <ArrowRight size={16} strokeWidth={1.75} />
              </LinkButton>
              <LinkButton href="/build" size="lg">
                Build a portfolio
              </LinkButton>
              <LinkButton href="/how-it-works" variant="ghost" size="lg">
                How it works
              </LinkButton>
            </div>
            <HeroStats items={ordered} total={priced.length} />
          </div>
          <div className="hidden lg:block">
            <CoinCluster items={ordered} />
          </div>
        </div>
      </section>

      {isConnected && address && (
        <Module ticks>
          <ModuleHeader index="02" title="Your portfolio" action={<Link href="/portfolio" className="text-[13px] text-primary font-medium">Open portfolio →</Link>} />
          <div className="module-grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr] rounded-none border-0">
            {loadingPortfolio && !portfolio ? (
              <div className="p-5">
                <Skeleton className="h-4 w-24 mb-3" />
                <Skeleton className="h-14 w-64" />
              </div>
            ) : (
              <Stat label="Total value" value={<AnimatedNumber value={portfolio?.totalValueUsd ?? 0} format={(v) => formatUsd(v)} />} size="xl" sub={<PriceChange value={portfolio?.change24hPct} />} />
            )}
            <Stat label="Cash · USDC" value={<AnimatedNumber value={portfolio?.usdcValueUsd ?? 0} format={(v) => formatUsd(v)} />} size="lg" sub={portfolio && portfolio.earnValueUsd > 0 ? `+ ${formatUsd(portfolio.earnValueUsd)} in Earn` : undefined} />
            <Stat label="Positions" value={portfolio?.holdings.length ?? 0} size="lg" sub="multiplier-aware" />
          </div>
          {portfolio && portfolio.holdings.length > 0 && (
            <div className="px-4 py-4 border-t border-line">
              <AllocationBar
                height={10}
                segments={[
                  ...portfolio.holdings.map((h) => ({ key: h.assetAddress, label: h.underlying, weightBps: h.currentWeightBps })),
                  ...(portfolio.usdcValueUsd > 0 ? [{ key: "USDC", label: "USDC", weightBps: Math.round((portfolio.usdcValueUsd / portfolio.totalValueUsd) * 10_000) }] : []),
                  ...(portfolio.earnValueUsd > 0 ? [{ key: "EARN", label: "Earn", weightBps: Math.round((portfolio.earnValueUsd / portfolio.totalValueUsd) * 10_000) }] : []),
                ]}
              />
            </div>
          )}
          {portfolio && portfolio.holdings.length === 0 && (
            <div className="px-4 py-4 border-t border-line flex flex-col gap-3">
              <div className="flex items-center gap-2 flex-wrap text-[13px] text-ink-secondary">
                <Badge>No positions yet</Badge> Start with a quick buy below or build a basket.
              </div>
              {portfolio.usdcValueUsd < 1 && <FundWallet compact />}
            </div>
          )}
        </Module>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6">
        <div className="flex flex-col gap-6">
          <Module>
            <ModuleHeader index={isConnected ? "03" : "02"} title="Quick buy" action={<Link href="/markets" className="text-[13px] text-primary font-medium">All markets</Link>} />
            <div className="grid grid-cols-2 md:grid-cols-4">
              {quick.map(({ asset, price }) => (
                <Link key={asset.canonicalId} href={`/stocks/${asset.address}?trade=buy`} className="rail p-4 border-r border-b border-line md:border-b-0 [&:nth-child(2n)]:border-r-0 md:[&:nth-child(2n)]:border-r md:last:border-r-0 hover:bg-surface transition-fast">
                  <div className="flex items-center justify-between">
                    <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={36} />
                    <Sparkline points={sparks?.series24h[asset.canonicalId] ?? []} width={64} height={22} />
                  </div>
                  <div className="mt-3 font-medium">{asset.underlying}</div>
                  <div className="display num text-[20px]">
                    <AnimatedNumber value={price?.displayUsd} format={(v) => formatUsd(v)} />
                  </div>
                  <PriceChange value={hasMeaningfulChange(tradingStatus(asset, price).status, price) ? price?.marketChange24hPct : null} className="text-[12px]" />
                </Link>
              ))}
            </div>
          </Module>

          {isConnected && watched.length > 0 && (
            <Module>
              <ModuleHeader title="Watchlist" />
              {watched.map(({ asset, price }) => (
                <MiniRow key={asset.canonicalId} asset={asset} price={price} spark={sparks?.series24h[asset.canonicalId]} />
              ))}
            </Module>
          )}

          <GiftsCard />

          <Module>
            <ModuleHeader title="Top movers" />
            {movers.map(({ asset, price }) => (
              <MiniRow key={asset.canonicalId} asset={asset} price={price} spark={sparks?.series24h[asset.canonicalId]} />
            ))}
            {movers.length === 0 && (
              <div className="p-4 flex flex-col gap-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            )}
          </Module>

          <NewsModule title="Market news" limit={8} showTicker compact />
        </div>

        <div className="flex flex-col gap-6">
          <Module ticks>
            <ModuleHeader title="Build a portfolio" action={<Link href="/build" className="text-[13px] text-primary font-medium">Custom</Link>} />
            {sortTemplatesByLiveness(templates ?? [], assets).slice(0, 3).map((t) => {
              const live = templateLiveness(t, assets);
              return (
              <Link key={t.id} href={`/build/${t.slug}`} className="rail block px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                <div className="flex items-center justify-between gap-2">
                  <div className="display-medium text-[16px]">{t.name}</div>
                  <span className={`font-mono text-[11px] ${live.live === live.total ? "text-positive-fg" : "text-ink-muted"}`}>{live.live}/{live.total} live</span>
                </div>
                <div className="text-[13px] text-ink-secondary line-clamp-1">{t.description}</div>
                <div className="mt-2">
                  <AllocationBar height={6} legend={false} segments={t.allocations.map((a) => ({ key: a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : symbolFor(assets, a.assetAddress), weightBps: a.weightBps }))} />
                </div>
                <div className="mt-1 text-[11px] font-mono text-ink-muted">{t.allocations.map((a) => `${a.assetAddress === "USDC" ? "USDC" : symbolFor(assets, a.assetAddress)} ${bpsToPct(a.weightBps)}`).join(" · ")}</div>
              </Link>
              );
            })}
            <p className="px-4 py-3 text-[12px] text-ink-muted">Templates, not recommendations.</p>
          </Module>

          {isConnected && (
            <Module>
              <ModuleHeader title="Recent activity" action={<Link href="/activity" className="text-[13px] text-primary font-medium">All</Link>} />
              <ActivityList items={(activity ?? []).slice(0, 5)} compact />
            </Module>
          )}

          <PlatformStatsModule />

          <PublicFeed limit={6} />

          <CommunityPulseModule />
        </div>
      </div>

      <Module ticks>
        <ModuleHeader title="How it works" action={<Link href="/how-it-works" className="text-[13px] text-primary font-medium">Full walkthrough →</Link>} />
        <ol className="grid grid-cols-2 md:grid-cols-3">
          {HOW_IT_WORKS.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.title} className="p-5 border-b border-r border-line [&:nth-child(2n)]:border-r-0 [&:nth-child(n+5)]:border-b-0 md:[&:nth-child(2n)]:border-r md:[&:nth-child(3n)]:border-r-0 md:[&:nth-child(n+4)]:border-b-0 flex flex-col gap-2 min-h-[150px]">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-primary">0{i + 1}</span>
                  <Icon size={16} strokeWidth={1.75} className="text-ink-muted" />
                </div>
                <div className="display-medium text-[17px]">{s.title}</div>
                <p className="text-[13px] text-ink-secondary leading-snug max-w-[34ch]">{s.body}</p>
              </li>
            );
          })}
        </ol>
      </Module>

    </div>
  );
}

const HOW_IT_WORKS = [
  { icon: Search, title: "Find", body: "13 Coinbase Tokenized Stocks on Base, identified by contract address, read live from the chain." },
  { icon: BookOpen, title: "Understand", body: "Market, reference and executable prices stay separate. Shares are multiplier-aware." },
  { icon: ShoppingCart, title: "Buy & sell", body: "Firm quote, price impact and fee up front. Scoped approvals, simulation, one confirmation." },
  { icon: Wallet, title: "Hold", body: "Assets stay in your wallet. Issuer policies and pauses are explained, never hidden." },
  { icon: Layers, title: "Build", body: "Baskets with sliders or templates; each leg confirmed by you, partial fills shown honestly." },
  { icon: Send, title: "Send & earn", body: "Gift to a Basename, put idle USDC into Morpho, Aave or Compound, all discovered at runtime." },
];

function symbolFor(data: AssetsResponse | undefined, address: string): string {
  return data?.assets.find((a) => a.canonicalId === address.toLowerCase())?.underlying ?? address.slice(0, 6);
}

function MiniRow({ asset, price, spark }: { asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string]; spark?: number[] }) {
  return (
    <Link href={`/stocks/${asset.address}`} className="rail flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
      <span className="flex items-center gap-3 min-w-0">
        <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={28} />
        <span className="min-w-0">
          <span className="block font-medium text-[14px] leading-tight">{asset.underlying}</span>
          <span className="block text-[12px] text-ink-secondary truncate">{asset.name}</span>
        </span>
      </span>
      <Sparkline points={spark ?? []} width={72} height={24} className="hidden sm:block" />
      <span className="text-right">
        <span className="block display num text-[15px]">
          <AnimatedNumber value={price?.displayUsd} format={(v) => formatUsd(v)} />
        </span>
        <PriceChange value={hasMeaningfulChange(tradingStatus(asset, price).status, price) ? price?.marketChange24hPct : null} className="text-[12px]" />
      </span>
    </Link>
  );
}


/** Four live numbers under the headline: markets live, DEX liquidity, 24h volume, issued count. */
function HeroStats({ items, total }: { items: Array<{ asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string] }>; total: number }) {
  const live = items.filter((x) => {
    const st = tradingStatus(x.asset, x.price).status;
    return st === "tradable" || st === "thin";
  });
  const liquidity = live.reduce((sum, x) => sum + (x.price?.liquidityUsd ?? 0), 0);
  const volume = live.reduce((sum, x) => sum + (x.price?.volume24hUsd ?? 0), 0);
  const cells = [
    { label: "Live markets", value: String(live.length) },
    { label: "DEX liquidity", value: liquidity > 0 ? formatUsdCompact(liquidity) : "—" },
    { label: "DEX volume · 24h", value: volume > 0 ? formatUsdCompact(volume) : "—" },
    { label: "Issued", value: `${items.filter((x) => BigInt(x.asset.totalSupply ?? "0") > 0n).length} / ${total}` },
  ];
  return (
    <dl className="mt-7 grid grid-cols-2 sm:grid-cols-4 gap-px bg-line border border-line rounded-[8px] overflow-hidden max-w-[640px]">
      {cells.map((c) => (
        <div key={c.label} className="bg-canvas/85 px-3 py-2.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
          <dd className="display num text-[20px] leading-none mt-1">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The hero visual: the live markets as floating 3D coins, each a link to its stock page.
 * Numbers live in the stats strip and the quick-buy tiles, so the coins only whisper the
 * price on hover instead of repeating a list.
 */
function CoinCluster({ items }: { items: Array<{ asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string] }> }) {
  const live = items
    .filter((x) => {
      const st = tradingStatus(x.asset, x.price).status;
      return (st === "tradable" || st === "thin") && hasCoin(x.asset.underlying);
    })
    .slice(0, 6);
  if (live.length === 0) return null;
  const layout = [
    { size: 156, left: "2%", top: "26%", delay: 0 },
    { size: 118, left: "46%", top: "2%", delay: 900 },
    { size: 132, left: "62%", top: "44%", delay: 1700 },
    { size: 92, left: "30%", top: "64%", delay: 2600 },
    { size: 80, left: "78%", top: "8%", delay: 3300 },
    { size: 68, left: "6%", top: "0%", delay: 4100 },
  ];
  return (
    <div className="relative h-[360px] select-none">
      {live.map((x, i) => {
        const l = layout[i];
        const pct = x.price?.marketChange24hPct;
        return (
          <Link key={x.asset.canonicalId} href={`/stocks/${x.asset.address}`} aria-label={`${x.asset.underlying} on Base`} className="coin-link" style={{ left: l.left, top: l.top }}>
            <Coin3D underlying={x.asset.underlying} symbol={x.asset.symbol} fallbackSrc={x.asset.logoURI} size={l.size} float delay={l.delay} />
            <span className="coin-label num">
              {x.asset.underlying} {formatUsd(x.price?.displayUsd)}
              {pct !== null && pct !== undefined ? ` · ${pct > 0 ? "+" : ""}${pct.toFixed(2)}%` : ""}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * What the platform has done so far, in six figures. Every one is counted from a transaction
 * receipt on Base, never from a running counter; the full breakdown lives on /stats.
 */
function PlatformStatsModule() {
  const { data } = useStats();
  const s = data?.windows.all;
  const delivered = s ? s.directGifts + s.linksClaimed + s.poolClaims : 0;
  const cells = s
    ? [
        { label: "Traded via BStocks", value: formatUsdCompact(s.tradeVolumeUsd) },
        { label: "Trades here", value: s.trades.toLocaleString("en-US") },
        { label: "Wallets", value: s.wallets.toLocaleString("en-US") },
        { label: "Gifts delivered", value: delivered.toLocaleString("en-US") },
        { label: "USDC into Earn", value: formatUsdCompact(s.earnDepositUsd) },
        { label: "Plan runs", value: s.planRuns.toLocaleString("en-US") },
      ]
    : [];
  return (
    <Module ticks>
      <ModuleHeader title="BStocks so far" action={<Link href="/stats" className="text-[13px] text-primary font-medium">All stats →</Link>} />
      {!s ? (
        <div className="p-4">
          <Skeleton className="h-16" />
        </div>
      ) : (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-line">
          {cells.map((c) => (
            <div key={c.label} className="bg-canvas px-4 py-3 min-w-0">
              <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
              <dd className="display num text-[22px] leading-none mt-1 truncate">{c.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">Every figure is checked against its transaction receipt on Base{data ? ` · updated ${timeAgo(data.generatedAt)}` : ""}.</p>
    </Module>
  );
}

/** Live 7-day community pulse: most bought stocks, the top basket, trader count. */
function CommunityPulseModule() {
  const { data: pulse } = useCommunityPulse();
  const bought = pulse?.mostBought ?? [];
  const basket = pulse?.topBaskets?.[0];
  return (
    <Module>
      <ModuleHeader title="Community" action={<Link href="/community" className="text-[13px] text-primary font-medium">Open</Link>} />
      {!pulse ? (
        <div className="p-4">
          <Skeleton className="h-12" />
        </div>
      ) : bought.length === 0 && !basket ? (
        <p className="px-4 py-3 text-[13px] text-ink-secondary">Quiet week so far. Trades and published baskets from every user show up here.</p>
      ) : (
        <>
          {bought.length > 0 && (
            <div className="px-4 pt-3 pb-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1.5">Most bought · 7d</div>
              <ul className="flex flex-col">
                {bought.slice(0, 3).map((b, i) => (
                  <li key={b.assetAddress}>
                    <Link href={`/stocks/${b.assetAddress}`} className="flex items-center gap-2 py-1.5 hover:text-primary transition-fast">
                      <span className="font-mono text-[11px] text-ink-muted w-4">{i + 1}</span>
                      <span className="font-medium text-[14px]">{b.symbol}</span>
                      <span className="ml-auto font-mono num text-[12px] text-ink-secondary">
                        {b.trades} buy{b.trades === 1 ? "" : "s"}
                        {b.usd > 0 ? ` · ${formatUsdCompact(b.usd)}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {basket && (
            <Link href={`/baskets/${basket.id}`} className="block border-t border-line px-4 py-3 hover:bg-surface transition-fast">
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">Top basket</div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-[14px] truncate">{basket.name}</span>
                <span className="font-mono num text-[12px] text-ink-secondary shrink-0">{basket.votes} votes · {basket.clones} clones</span>
              </div>
            </Link>
          )}
          <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">{pulse.traders} wallet{pulse.traders === 1 ? "" : "s"} traded this week · templates, not recommendations.</p>
        </>
      )}
    </Module>
  );
}

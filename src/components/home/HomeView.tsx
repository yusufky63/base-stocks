"use client";

import Link from "next/link";
import { sortByTradingStatus, tradingStatus } from "@/lib/trading-status";
import { useAccount } from "wagmi";
import { ArrowRight, Search, BookOpen, ShoppingCart, Wallet, Layers, Send } from "lucide-react";
import { useAssets, useActivity, usePortfolio, useTemplates, useWatchlist, useSparklines } from "@/hooks/queries";
import type { AssetsResponse } from "@/lib/client-api";
import type { PortfolioTemplate } from "@/domain/portfolio";
import { formatUsd, bpsToPct, formatUsdCompact } from "@/lib/format";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { AllocationBar } from "@/components/common/AllocationBar";
import { LinkButton, Module, ModuleHeader, Skeleton, Stat, Badge } from "@/components/ui/primitives";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Sparkline } from "@/components/ui/Sparkline";
import { ActivityList } from "@/components/activity/ActivityList";
import { LetterGlitch } from "@/components/fx/LetterGlitch";
import { NewsModule } from "@/components/news/NewsModule";
import { FundWallet } from "@/components/common/FundWallet";

export function HomeView({ initialAssets, initialTemplates }: { initialAssets?: AssetsResponse; initialTemplates?: PortfolioTemplate[] }) {
  const { address, isConnected } = useAccount();
  const { data: assets } = useAssets(initialAssets);
  const { data: portfolio, isLoading: loadingPortfolio } = usePortfolio(address);
  const { data: templates } = useTemplates(initialTemplates);
  const { data: activity } = useActivity(address);
  const { data: sparks } = useSparklines();
  const watchlist = useWatchlist(address);

  const priced = (assets?.assets ?? []).map((a) => ({ asset: a, price: assets?.prices[a.canonicalId] }));
  const ordered = sortByTradingStatus(priced, (x) => x);
  const movers = ordered.filter((x) => tradingStatus(x.asset, x.price).status !== "not-issued" && x.price?.marketChange24hPct !== null && x.price?.marketChange24hPct !== undefined).sort((a, b) => Math.abs(b.price?.marketChange24hPct ?? 0) - Math.abs(a.price?.marketChange24hPct ?? 0)).slice(0, 6);
  const watched = priced.filter(({ asset }) => watchlist.has(asset.address));
  const quick = ordered.slice(0, 4);

  return (
    <div className="flex flex-col gap-6">
      <section className="hero-fx border border-line rounded-[8px] ticks overflow-hidden bg-canvas">
        <LetterGlitch className="fx-layer" glitchSpeed={70} opacity={0.22} outerVignette centerVignette />
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
            <LiveNowPanel items={ordered} total={priced.length} />
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
                    <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={28} />
                    <Sparkline points={sparks?.series[asset.canonicalId] ?? []} width={64} height={22} />
                  </div>
                  <div className="mt-3 font-medium">{asset.underlying}</div>
                  <div className="display num text-[20px]">
                    <AnimatedNumber value={price?.displayUsd} format={(v) => formatUsd(v)} />
                  </div>
                  <PriceChange value={price?.marketChange24hPct} className="text-[12px]" />
                </Link>
              ))}
            </div>
          </Module>

          {isConnected && watched.length > 0 && (
            <Module>
              <ModuleHeader title="Watchlist" />
              {watched.map(({ asset, price }) => (
                <MiniRow key={asset.canonicalId} asset={asset} price={price} spark={sparks?.series[asset.canonicalId]} />
              ))}
            </Module>
          )}

          <Module>
            <ModuleHeader title="Top movers" />
            {movers.map(({ asset, price }) => (
              <MiniRow key={asset.canonicalId} asset={asset} price={price} spark={sparks?.series[asset.canonicalId]} />
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
            {(templates ?? []).slice(0, 3).map((t) => (
              <Link key={t.id} href={`/build/${t.slug}`} className="rail block px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                <div className="display-medium text-[16px]">{t.name}</div>
                <div className="text-[13px] text-ink-secondary line-clamp-1">{t.description}</div>
                <div className="mt-2">
                  <AllocationBar height={6} legend={false} segments={t.allocations.map((a) => ({ key: a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : symbolFor(assets, a.assetAddress), weightBps: a.weightBps }))} />
                </div>
                <div className="mt-1 text-[11px] font-mono text-ink-muted">{t.allocations.map((a) => `${a.assetAddress === "USDC" ? "USDC" : symbolFor(assets, a.assetAddress)} ${bpsToPct(a.weightBps)}`).join(" · ")}</div>
              </Link>
            ))}
            <p className="px-4 py-3 text-[12px] text-ink-muted">Templates, not recommendations.</p>
          </Module>

          {isConnected && (
            <Module>
              <ModuleHeader title="Recent activity" action={<Link href="/activity" className="text-[13px] text-primary font-medium">All</Link>} />
              <ActivityList items={(activity ?? []).slice(0, 5)} compact />
            </Module>
          )}

          <Module>
            <ModuleHeader title="Community" action={<Link href="/community" className="text-[13px] text-primary font-medium">Open</Link>} />
            <p className="px-4 py-3 text-[13px] text-ink-secondary">Most bought and sold this week, baskets published by other users, votes and clones. Share any stock with your referral tag to earn badges.</p>
          </Module>
        </div>
      </div>

      <Module ticks>
        <ModuleHeader title="How it works" action={<Link href="/how-it-works" className="text-[13px] text-primary font-medium">Full walkthrough →</Link>} />
        <ol className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
          {HOW_IT_WORKS.map((s, i) => {
            const Icon = s.icon;
            return (
              <li key={s.title} className="p-4 border-b lg:border-b-0 border-r border-line [&:nth-child(2n)]:border-r-0 md:[&:nth-child(2n)]:border-r md:[&:nth-child(3n)]:border-r-0 lg:[&:nth-child(3n)]:border-r lg:last:border-r-0 flex flex-col gap-2 min-h-[150px]">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-primary">0{i + 1}</span>
                  <Icon size={16} strokeWidth={1.75} className="text-ink-muted" />
                </div>
                <div className="display-medium text-[17px]">{s.title}</div>
                <p className="text-[12px] text-ink-secondary leading-snug">{s.body}</p>
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
        <PriceChange value={price?.marketChange24hPct} className="text-[12px]" />
      </span>
    </Link>
  );
}

/** Hero side panel: the stocks with a live onchain market right now, price and 24h move, then the count. */
function LiveNowPanel({ items, total }: { items: Array<{ asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string] }>; total: number }) {
  const live = items.filter((x) => {
    const st = tradingStatus(x.asset, x.price).status;
    return st === "tradable" || st === "thin";
  });
  const liquidity = live.reduce((sum, x) => sum + (x.price?.liquidityUsd ?? 0), 0);
  return (
    <div className="border border-line rounded-[8px] bg-canvas/90 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 h-10 border-b border-line">
        <span className="inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          <span className="live-dot" /> Live on Base
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          {live.length} of {total} issued
        </span>
      </div>
      <ul className="divide-y divide-line">
        {live.slice(0, 5).map(({ asset, price }) => (
          <li key={asset.canonicalId}>
            <Link href={`/stocks/${asset.address}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface transition-fast">
              <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium leading-tight">{asset.underlying}</span>
                <span className="block text-[11px] text-ink-muted truncate">{asset.name}</span>
              </span>
              <span className="text-right">
                <span className="block font-mono num text-[14px]">{formatUsd(price?.displayUsd)}</span>
                <PriceChange value={price?.marketChange24hPct} className="text-[11px]" />
              </span>
            </Link>
          </li>
        ))}
        {live.length === 0 && <li className="px-4 py-4 text-[13px] text-ink-secondary">No live market right now.</li>}
      </ul>
      <div className="px-4 py-2.5 border-t border-line flex items-center justify-between text-[11px] text-ink-muted">
        <span>{liquidity > 0 ? `${formatUsdCompact(liquidity)} DEX liquidity` : "DEX liquidity n/a"}</span>
        <Link href="/markets" className="text-primary font-medium">
          All markets →
        </Link>
      </div>
    </div>
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
    { label: "24h volume", value: volume > 0 ? formatUsdCompact(volume) : "—" },
    { label: "Issued", value: `${live.length} / ${total}` },
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

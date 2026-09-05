"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import type { PortfolioTemplate } from "@/domain/portfolio";
import { usePortfolio, useTemplates, useSparklines, useAssets, useActivity } from "@/hooks/queries";
import { formatTokenAmount, formatUsd, formatPct } from "@/lib/format";
import { maxDriftBps } from "@/lib/portfolio/drift";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { AllocationBar, ColorDot } from "@/components/common/AllocationBar";
import { assetColor } from "@/lib/colors";
import { Module, ModuleHeader, Skeleton, Stat, LinkButton, PageTitle, cx } from "@/components/ui/primitives";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Sparkline } from "@/components/ui/Sparkline";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { useTargetAllocation, MY_TARGET_ID } from "./TargetAllocation";
import { RebalancePanel, type TargetChoice } from "./RebalancePanel";
import { HistoryModule } from "./HistoryModule";
import { ProfileSettings } from "./ProfileSettings";
import { ActivityList } from "@/components/activity/ActivityList";
import { GiftInbox } from "@/components/gift/GiftInbox";
import { AutomationCard } from "./AutomationCard";
import { PortfolioDigestCard } from "./PortfolioDigestCard";
import { PnlModule } from "./PnlModule";
import { LpPositionsModule } from "@/components/earn/LpPositionsModule";
import { OrdersModule } from "@/components/trade/OrdersModule";
import { FundWallet } from "@/components/common/FundWallet";

type Tab = "overview" | "rebalance" | "activity" | "profile";
const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: "overview", label: "Overview", hint: "Value · allocation · history" },
  { id: "rebalance", label: "Rebalance", hint: "Drift against a target" },
  { id: "activity", label: "Activity", hint: "Trades, sends, earn, builds" },
  { id: "profile", label: "Profile", hint: "Your page and badges" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.id === v);

const PROVIDER_LABEL: Record<string, string> = { morpho: "Morpho", aave: "Aave", compound: "Compound", aerodrome: "Aerodrome", uniswap: "Uniswap" };

/**
 * Portfolio (spec §45) as four tabs. The tab lives in the URL (`?tab=rebalance`) so a link from
 * Automate or a shared address lands on the right panel and the back button does what it says.
 */
export function PortfolioView({ initialTemplates }: { initialTemplates?: PortfolioTemplate[] }) {
  const { address, isConnected } = useAccount();
  const { data, isLoading, isError, refetch } = usePortfolio(address);
  const { data: templates } = useTemplates(initialTemplates);
  const { data: sparks } = useSparklines();
  const { data: assets } = useAssets();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tabParam = search.get("tab");
  const tab: Tab = isTab(tabParam) ? tabParam : "overview";
  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(search.toString());
      if (next === "overview") params.delete("tab");
      else params.set("tab", next);
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [router, pathname, search],
  );
  const [templateId, setTemplateId] = useState<string>("");

  const savedTarget = useTargetAllocation();
  const driftBps = useMemo(() => (data ? maxDriftBps(data, savedTarget.allocations) : null), [data, savedTarget.allocations]);
  /**
   * The thing being compared against. A saved target is the wallet's own mix and outranks a
   * template, so it is selected by default the moment one exists — a template you once looked at
   * should not keep winning over the target you deliberately set.
   */
  const choices = useMemo<TargetChoice[]>(
    () => [...(savedTarget.allocations ? [{ id: MY_TARGET_ID, name: "your target", allocations: savedTarget.allocations }] : []), ...(templates ?? []).map((t) => ({ id: t.id, name: t.name, allocations: t.allocations }))],
    [templates, savedTarget.allocations],
  );
  const target = useMemo(() => {
    if (templateId === MY_TARGET_ID || (templateId === "" && savedTarget.allocations)) return choices.find((c) => c.id === MY_TARGET_ID);
    return choices.find((c) => c.id === templateId);
  }, [choices, templateId, savedTarget.allocations]);

  if (!isConnected || !address) {
    return (
      <div className="border border-line rounded-[8px] ticks bg-canvas p-8 md:p-12 flex flex-col gap-4 items-start">
        <div className="eyebrow">04 — Portfolio</div>
        <h1 className="display text-[36px] md:text-[56px] leading-[0.95]">Your stocks, your wallet.</h1>
        <p className="text-ink-secondary max-w-[48ch]">Connect a wallet to see multiplier-aware holdings, allocation, drift against a target and value history. Browsing markets never requires a wallet.</p>
        <ConnectButton size="lg" />
      </div>
    );
  }

  const segments = data
    ? [
        ...data.holdings.map((h) => ({ key: h.assetAddress, label: h.underlying, weightBps: h.currentWeightBps })),
        ...(data.usdcValueUsd > 0 ? [{ key: "USDC", label: "USDC", weightBps: Math.round((data.usdcValueUsd / data.totalValueUsd) * 10_000) }] : []),
        ...(data.earnValueUsd > 0 ? [{ key: "EARN", label: "Earn", weightBps: Math.round((data.earnValueUsd / data.totalValueUsd) * 10_000) }] : []),
        ...(data.lpValueUsd > 0 ? [{ key: "LP", label: "Liquidity", weightBps: Math.round((data.lpValueUsd / data.totalValueUsd) * 10_000) }] : []),
      ]
    : [];
  const venuePositions = data ? data.earnPositions.length + data.lpPositions.length : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="04 — Portfolio" title="Portfolio" />

      <div className="module-grid grid-cols-2 md:grid-cols-[2fr_1fr_1fr_1fr] ticks">
        {isLoading && !data ? (
          <div className="p-5 col-span-2 md:col-span-1">
            <Skeleton className="h-4 w-24 mb-3" />
            <Skeleton className="h-16 w-64" />
          </div>
        ) : (
          <div className="col-span-2 md:col-span-1">
            <Stat
              label="Total value"
              value={<AnimatedNumber value={data?.totalValueUsd ?? 0} format={(v) => formatUsd(v)} />}
              size="xl"
              sub={
                <span>
                  {data && data.change24hPct !== null ? <PriceChange value={data.change24hPct} /> : "—"} today · stocks + USDC + Earn + liquidity
                </span>
              }
            />
          </div>
        )}
        <Stat label="Cash · USDC" value={<AnimatedNumber value={data?.usdcValueUsd ?? 0} format={(v) => formatUsd(v)} />} size="lg" sub="ready to buy or rebalance" />
        <Stat label="In Earn & pools" value={<AnimatedNumber value={(data?.earnValueUsd ?? 0) + (data?.lpValueUsd ?? 0)} format={(v) => formatUsd(v)} />} size="lg" sub={venuePositions > 0 ? `${venuePositions} position${venuePositions > 1 ? "s" : ""}${data && data.lpPositions.length > 0 ? ` · ${data.lpPositions.length} LP` : ""}` : "USDC in venues, LP pools"} />
        <Stat label="Positions" value={data?.holdings.length ?? 0} size="lg" sub={data ? `updated ${new Date(data.readAt).toLocaleTimeString()}` : undefined} />
      </div>

      {isError && (
        <p className="text-[14px] text-danger-fg">
          Portfolio could not be loaded.{" "}
          <button className="underline" onClick={() => refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && data.usdcValueUsd < 1 && data.holdings.length === 0 && data.earnValueUsd < 1 && data.lpValueUsd < 1 && <FundWallet />}

      <div role="tablist" aria-label="Portfolio sections" className="grid grid-cols-4 p-1 rounded-[8px] bg-surface-muted">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cx("h-11 rounded-[6px] px-1 md:px-2 text-[12px] md:text-[13px] font-medium transition-fast flex flex-col items-center justify-center leading-tight", tab === t.id ? "bg-canvas border border-line text-primary" : "text-ink-secondary hover:text-ink")}>
            <span>{t.label}</span>
            <span className="hidden lg:block font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">{t.hint}</span>
          </button>
        ))}
      </div>

      {/* Drift is the one thing worth interrupting the overview for: it is the only number here
          that asks the holder to do something. It is measured exactly as the Rebalance tab measures it. */}
      {tab === "overview" && data && driftBps !== null && driftBps > savedTarget.thresholdBps && (
        <button type="button" onClick={() => setTab("rebalance")} className="text-left border border-warning-fg/50 rounded-[8px] px-4 py-3 text-[13px] hover:bg-surface transition-fast">
          <span className="font-medium">{`Your mix has drifted ${(driftBps / 100).toFixed(1)}% from your target.`}</span>{" "}
          <span className="text-ink-secondary">Open Rebalance to see which leg moved and by how much — nothing trades without your confirmation.</span>
        </button>
      )}

      {tab === "overview" && <GiftInbox address={address} />}
      {tab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
          <div className="flex flex-col gap-6">
            <PortfolioDigestCard address={address} />
            <Module>
              <ModuleHeader index="A" title="Allocation" />
              {segments.length > 0 ? (
                <div className="p-4">
                  <AllocationBar segments={segments} />
                </div>
              ) : (
                <div className="p-4 flex flex-col gap-3">
                  <p className="text-[14px] text-ink-secondary">No stock positions yet.</p>
                  <div className="flex gap-2">
                    <LinkButton href="/markets" variant="primary" size="sm">
                      Buy a stock
                    </LinkButton>
                    <LinkButton href="/build" size="sm">
                      Build a portfolio
                    </LinkButton>
                    <LinkButton href="/automate" size="sm">
                      Start a plan
                    </LinkButton>
                  </div>
                </div>
              )}
            </Module>

            <Module>
              <ModuleHeader index="B" title="Holdings" />
              {data?.holdings.map((h) => (
                <Link key={h.assetAddress} href={`/stocks/${h.assetAddress}`} className="rail grid grid-cols-[1fr_auto] md:grid-cols-[1fr_96px_140px_120px_100px] items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="w-1 self-stretch rounded-full" style={{ background: assetColor(h.assetAddress) }} aria-hidden />
                    <AssetLogo src={h.logoURI} symbol={h.symbol} size={36} />
                    <span className="min-w-0">
                      <span className="block font-medium text-[15px]">{h.underlying}</span>
                      <span className="block text-[12px] text-ink-secondary font-mono num">
                        {formatTokenAmount(h.scaledBalance, h.decimals)} shares{BigInt(h.multiplier) !== 10n ** 18n ? " · adj." : ""}
                      </span>
                    </span>
                  </span>
                  <span className="hidden md:flex justify-end">
                    <Sparkline points={sparks?.series[h.assetAddress.toLowerCase()] ?? []} width={72} height={24} />
                  </span>
                  <span className="text-right">
                    <span className="block display num text-[16px]">
                      <AnimatedNumber value={h.marketValueUsd} format={(v) => formatUsd(v)} />
                    </span>
                    <span className="md:hidden block text-[12px]">
                      <PriceChange value={h.change24hPct} />
                    </span>
                  </span>
                  <span className="hidden md:block text-right font-mono num text-[13px] text-ink-secondary">
                    {formatUsd(h.priceUsd)}
                    {h.priceSource === "reference" && <span className="block text-[10px] uppercase text-ink-muted">reference</span>}
                  </span>
                  <span className="hidden md:block text-right">
                    <PriceChange value={h.change24hPct} />
                  </span>
                </Link>
              ))}
              {data && data.holdings.length === 0 && (
                <div className="px-4 py-5 flex flex-col gap-3 items-start">
                  <p className="text-[14px] text-ink-secondary max-w-[52ch]">No stock in this wallet yet. Your first position appears here the moment it lands — a quick buy from about a dollar, a basket, or a gift someone sends you.</p>
                  <div className="flex gap-2 flex-wrap">
                    <Link href="/markets" className="inline-flex items-center h-9 px-3 rounded-[6px] text-[13px] font-medium bg-primary text-primary-contrast hover:bg-primary-strong transition-fast">
                      Browse markets
                    </Link>
                    <Link href="/build" className="inline-flex items-center h-9 px-3 rounded-[6px] text-[13px] font-medium border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
                      Build a basket
                    </Link>
                  </div>
                </div>
              )}
              {!data && isLoading && (
                <div className="p-4 flex flex-col gap-2">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              )}
            </Module>

            {data && data.holdings.length > 0 && <PnlModule address={address} />}

            <Module>
              <ModuleHeader title="Earn" action={<Link href="/earn" className="text-[13px] text-primary font-medium">Manage →</Link>} />
              {data && data.earnPositions.length > 0 ? (
                <ul>
                  {data.earnPositions.map((p, i) => (
                    <li key={`${p.provider}-${p.title}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium truncate">{p.title}</span>
                        <span className="block text-[12px] text-ink-secondary">
                          {PROVIDER_LABEL[p.provider] ?? p.provider}
                          {p.variableApy !== undefined ? ` · ${formatPct(p.variableApy, { sign: false })} variable` : ""}
                        </span>
                      </span>
                      <span className="display num text-[15px] inline-flex items-center gap-2">
                        <ColorDot k="EARN" /> {formatUsd(p.valueUsd)}
                      </span>
                    </li>
                  ))}
                  {(() => {
                    const rated = data.earnPositions.filter((p) => p.variableApy !== undefined && p.valueUsd > 0);
                    const total = rated.reduce((a, p) => a + p.valueUsd, 0);
                    if (rated.length < 2 || total <= 0) return null;
                    const blended = rated.reduce((a, p) => a + p.valueUsd * p.variableApy!, 0) / total;
                    return (
                      <li className="px-4 py-2 text-[12px] text-ink-secondary flex items-center justify-between">
                        <span>Blended rate across positions</span>
                        <span className="num font-mono">{`≈ ${formatPct(blended, { sign: false })} variable`}</span>
                      </li>
                    );
                  })()}
                </ul>
              ) : (
                <p className="px-4 py-4 text-[13px] text-ink-secondary">No USDC in a yield venue yet. Idle cash can earn a variable rate in Morpho, Aave or Compound while staying under your control.</p>
              )}
              <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Deposits in Morpho, Aave and Compound stay in your wallet and count toward the total above. Liquidity positions are listed below.</p>
            </Module>
            <LpPositionsModule compact />
          </div>

          <div className="flex flex-col gap-6">
            <AutomationCard />
            <HistoryModule address={address} />
            <Module>
              <OrdersModule owner={address} showEmpty />
            </Module>
          </div>
        </div>
      )}

      {tab === "rebalance" && data && <RebalancePanel snapshot={data} assets={assets} target={target} choices={choices} onChoose={setTemplateId} saved={savedTarget} />}
      {tab === "rebalance" && !data && <Skeleton className="h-64" />}

      {tab === "activity" && <ActivityTab address={address} />}

      {tab === "profile" && <ProfileSettings address={address} />}
    </div>
  );
}

function ActivityTab({ address }: { address: `0x${string}` }) {
  const { data, isLoading, isError, refetch } = useActivity(address);
  return (
    <Module>
      <ModuleHeader
        title="Timeline"
        action={
          <span className="flex items-center gap-3">
            <button className="text-[13px] text-primary font-medium" onClick={() => refetch()}>
              Refresh
            </button>
            <Link href="/activity" className="text-[13px] text-ink-secondary hover:text-ink">
              Full page →
            </Link>
          </span>
        }
      />
      {isLoading && !data && (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      )}
      {isError && <p className="px-4 py-4 text-[14px] text-danger-fg">Activity could not be loaded.</p>}
      {data && <ActivityList items={data} />}
      <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Buys, sells, sends, basket builds, plan runs and Earn deposits/withdrawals. App records stay “pending verification” until the matching onchain transfer or receipt is found.</p>
    </Module>
  );
}

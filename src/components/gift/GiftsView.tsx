"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { Gift as GiftIcon, Send } from "lucide-react";
import type { PortfolioHolding } from "@/domain/portfolio";
import { useAssets, usePortfolio, useRegion } from "@/hooks/queries";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { RegionNotice } from "@/components/common/RegionNotice";
import { Button, LinkButton, Module, PageTitle, Skeleton, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { isPoolDeployed } from "@/lib/pool";
import { PoolCreateFlow } from "@/components/pool/PoolCreateFlow";
import { PoolHistory } from "@/components/pool/PoolHistory";
import { PoolList, usePublicPools, remainingShares } from "@/components/pool/PoolList";
import { ClaimLinkFlow } from "./ClaimLinkFlow";
import { BulkClaimLinks } from "./BulkClaimLinks";
import { GiftHistory } from "./GiftHistory";
import { SendSheet } from "./SendSheet";

type Tab = "create" | "discover" | "history";
type Mode = "address" | "link" | "bulk" | "pool";

const subscribeNever = () => () => {};

/** `?basket=0x…,0x…&title=` → the pool creator's preset, or null when the URL carries none. */
function parseBasketPreset(search: string): { assets: string[]; slots: number; title?: string } | null {
  const p = new URLSearchParams(search);
  const basket = p.get("basket");
  if (!basket) return null;
  const assets = basket
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (assets.length === 0) return null;
  return { assets, slots: 1, title: p.get("title") ?? undefined };
}

/**
 * The Gift page: pick a stock you hold, choose how to give it — straight to an address or
 * Basename, one claim link, or a batch of links — and see everything sent and received.
 */
export function GiftsView() {
  const { address, isConnected } = useAccount();
  // A basket handed over from Build (`/gifts?basket=0x…,0x…&title=`) opens the pool creator with
  // its stocks picked and one share. The URL is read as an external store — empty on the server,
  // the real one after hydration — so the page stays static and nothing is set from an effect.
  const search = useSyncExternalStore(subscribeNever, () => window.location.search, () => "");
  const preset = useMemo(() => parseBasketPreset(search), [search]);
  const [tabState, setTab] = useState<Tab | null>(null);
  const [modeState, setMode] = useState<Mode | null>(null);
  const tab: Tab = tabState ?? "create";
  const mode: Mode = modeState ?? (preset ? "pool" : "link");
  const [picked, setPicked] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const portfolio = usePortfolio(address);
  const assets = useAssets();
  const poolsEnabled = isPoolDeployed();
  // The tab count is the point of the label: "Claim (3)" is an invitation, "Claim" is furniture.
  const region = useRegion();
  // Giving a stock away is a distribution, not browsing: the eligibility check gates it the same
  // way it gates a trade. Claiming is gated on the claim page, where the claimant actually is.
  const restricted = region.data?.restricted === true;
  const publicPools = usePublicPools();
  const openCount = (publicPools.data ?? []).filter((v) => v.pool.status === "live" && remainingShares(v) > 0).length;

  const holdings = useMemo(() => (portfolio.data?.holdings ?? []).filter((h) => BigInt(h.rawBalance) > 0n), [portfolio.data]);
  const holding: PortfolioHolding | null = holdings.find((h) => h.assetAddress.toLowerCase() === picked) ?? holdings[0] ?? null;
  const assetDTO = holding ? (assets.data?.assets.find((a) => a.canonicalId === holding.assetAddress.toLowerCase()) ?? null) : null;
  const raw = holding ? BigInt(holding.rawBalance) : 0n;
  const scaled = holding ? BigInt(holding.scaledBalance) : 0n;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="Gift" title="Give stock" lead="To a Basename, to an address, or as a claim link that needs no wallet at all — the stock stays self-custodial the whole way." />

      <Segmented<Tab>
        className="max-w-[440px]"
        ariaLabel="Gift sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: "create", label: "Create" },
          ...(poolsEnabled ? ([{ value: "discover" as Tab, label: openCount > 0 ? `Claim (${openCount})` : "Claim" }] as const) : []),
          { value: "history", label: "Yours" },
        ]}
      />

      {tab === "discover" ? (
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-ink-secondary max-w-[70ch]">
            Pools anyone can take a share of, listed by the people who funded them. One share per wallet; whatever nobody claims goes back to the creator.
          </p>
          <PoolList columns={2} />
        </div>
      ) : tab === "history" ? (
        <div className="flex flex-col gap-6">
          {poolsEnabled && address && <PoolHistory owner={address} />}
          <Module>{address ? <GiftHistory owner={address} /> : <div className="p-6 flex flex-col items-start gap-3"><p className="text-[14px] text-ink-secondary">Connect a wallet to see your gifts.</p><ConnectButton /></div>}</Module>
        </div>
      ) : restricted && region.data ? (
        <RegionNotice region={region.data} />
      ) : !isConnected ? (
        <Module>
          <div className="p-6 flex flex-col items-start gap-3">
            <p className="text-[14px] text-ink-secondary">Connect a wallet to gift stock you hold.</p>
            <ConnectButton size="lg" />
          </div>
        </Module>
      ) : portfolio.isLoading ? (
        <Module>
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        </Module>
      ) : holdings.length === 0 ? (
        <Module>
          <div className="px-4 py-3 border-b border-line font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">1 · What to give</div>
          <div className="px-4 py-4 border-b border-line">
            <p className="text-[14px] text-ink-secondary">Nothing to gift yet — you gift stock you hold. Pick one to buy first; it takes a minute and comes straight back here.</p>
          </div>
          <ul>
            {(assets.data?.assets ?? []).slice(0, 5).map((a) => {
              const price = assets.data?.prices[a.canonicalId]?.displayUsd ?? null;
              return (
                <li key={a.address}>
                  <Link href={`/stocks/${a.address}`} className="flex items-center gap-3 px-4 py-3 border-b border-line hover:bg-surface transition-fast">
                    <AssetLogo src={a.logoURI} symbol={a.underlying} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[14px]">{a.underlying}</span>
                      <span className="block text-[12px] text-ink-secondary truncate">{a.name}</span>
                    </span>
                    {price !== null && <span className="font-mono num text-[13px] text-ink-secondary">{formatUsd(price)}</span>}
                    <span className="text-[13px] text-primary font-medium shrink-0">Buy →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="p-4">
            <LinkButton href="/markets" variant="primary">
              Browse all markets
            </LinkButton>
          </div>
        </Module>
      ) : (
        <div className={cx("grid grid-cols-1 gap-6 items-start", mode !== "pool" && "lg:grid-cols-[2fr_3fr]")}>
          <Module className={cx(mode === "pool" && "hidden")}>
            <div className="px-4 py-3 border-b border-line font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">1 · What to give</div>
            <ul>
              {holdings.map((h) => {
                const active = holding?.assetAddress === h.assetAddress;
                return (
                  <li key={h.assetAddress}>
                    <button
                      type="button"
                      onClick={() => setPicked(h.assetAddress.toLowerCase())}
                      aria-pressed={active}
                      className={cx("w-full flex items-center gap-3 px-4 py-3 border-b border-line text-left transition-fast", active ? "bg-primary-soft/50" : "hover:bg-surface")}
                    >
                      <AssetLogo src={h.logoURI} symbol={h.underlying} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-[14px]">{h.underlying}</span>
                        <span className="block font-mono num text-[12px] text-ink-secondary">{`${formatTokenAmount(h.scaledBalance, h.decimals)} shares`}</span>
                      </span>
                      <span className={cx("w-4 h-4 rounded-full border inline-flex items-center justify-center shrink-0", active ? "border-primary bg-primary" : "border-line-strong")} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Module>

          <Module>
            <div className="px-4 py-3 border-b border-line flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">2 · How to give it</span>
            </div>
            <div className="p-4 flex flex-col gap-4">
              <Segmented<Mode>
                size="sm"
                ariaLabel="Gift type"
                value={mode}
                onChange={setMode}
                options={[
                  ...(poolsEnabled ? ([{ value: "pool" as Mode, label: "Pool" }] as const) : []),
                  { value: "link", label: "Claim link" },
                  { value: "bulk", label: "Many links" },
                  { value: "address", label: "To an address" },
                ]}
              />
              {mode === "pool" ? (
                <PoolCreateFlow holdings={holdings} assets={assets.data?.assets ?? []} preset={preset ?? undefined} />
              ) : assetDTO && holding ? (
                mode === "link" ? (
                  <ClaimLinkFlow key={`link-${assetDTO.address}`} asset={assetDTO} raw={raw} scaled={scaled} priceUsd={holding.priceUsd} />
                ) : mode === "bulk" ? (
                  <BulkClaimLinks key={`bulk-${assetDTO.address}`} asset={assetDTO} raw={raw} scaled={scaled} priceUsd={holding.priceUsd} />
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-[13px] text-ink-secondary">
                      <Send size={14} strokeWidth={1.75} className="inline mr-1.5 text-primary" />
                      Straight to a Basename like alice.base.eth or a 0x address — the recipient and the resolved address are shown before you confirm.
                    </p>
                    <Button size="lg" onClick={() => setSendOpen(true)}>
                      {`Send ${assetDTO.underlying} to someone`}
                    </Button>
                    <SendSheet open={sendOpen} onClose={() => setSendOpen(false)} asset={assetDTO} raw={raw} scaled={scaled} priceUsd={holding.priceUsd} />
                  </div>
                )
              ) : (
                <Skeleton className="h-24" />
              )}
            </div>
          </Module>
        </div>
      )}

      <p className="text-[12px] text-ink-muted flex items-center gap-1.5">
        <GiftIcon size={13} strokeWidth={1.75} />
        Claim links are held by an ownerless escrow contract, cancellable any time before claim.{" "}
        <Link href="/how-it-works" className="text-primary">
          How it works →
        </Link>
      </p>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { Gift as GiftIcon, Send } from "lucide-react";
import type { PortfolioHolding } from "@/domain/portfolio";
import { useAssets, usePortfolio } from "@/hooks/queries";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { Button, LinkButton, Module, PageTitle, Skeleton, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { ClaimLinkFlow } from "./ClaimLinkFlow";
import { BulkClaimLinks } from "./BulkClaimLinks";
import { GiftHistory } from "./GiftHistory";
import { SendSheet } from "./SendSheet";

type Tab = "create" | "history";
type Mode = "address" | "link" | "bulk";

/**
 * The Gift page: pick a stock you hold, choose how to give it — straight to an address or
 * Basename, one claim link, or a batch of links — and see everything sent and received.
 */
export function GiftsView() {
  const { address, isConnected } = useAccount();
  const [tab, setTab] = useState<Tab>("create");
  const [mode, setMode] = useState<Mode>("link");
  const [picked, setPicked] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const portfolio = usePortfolio(address);
  const assets = useAssets();

  const holdings = useMemo(() => (portfolio.data?.holdings ?? []).filter((h) => BigInt(h.rawBalance) > 0n), [portfolio.data]);
  const holding: PortfolioHolding | null = holdings.find((h) => h.assetAddress.toLowerCase() === picked) ?? holdings[0] ?? null;
  const assetDTO = holding ? (assets.data?.assets.find((a) => a.canonicalId === holding.assetAddress.toLowerCase()) ?? null) : null;
  const raw = holding ? BigInt(holding.rawBalance) : 0n;
  const scaled = holding ? BigInt(holding.scaledBalance) : 0n;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="Gift" title="Give stock" lead="To a Basename, to an address, or as a claim link that needs no wallet at all — the stock stays self-custodial the whole way." />

      <Segmented<Tab>
        className="max-w-[360px]"
        ariaLabel="Gift sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: "create", label: "Create" },
          { value: "history", label: "History" },
        ]}
      />

      {tab === "history" ? (
        <Module>{address ? <GiftHistory owner={address} /> : <div className="p-6 flex flex-col items-start gap-3"><p className="text-[14px] text-ink-secondary">Connect a wallet to see your gifts.</p><ConnectButton /></div>}</Module>
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
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-6 items-start">
          <Module>
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
                  { value: "link", label: "Claim link" },
                  { value: "bulk", label: "Many links" },
                  { value: "address", label: "To an address" },
                ]}
              />
              {assetDTO && holding ? (
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

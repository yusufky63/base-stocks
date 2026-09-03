"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";
import { Sprout, ShieldCheck, Layers } from "lucide-react";
import type { EarnOpportunity } from "@/domain/earn";
import { apiGet } from "@/lib/client-api";
import { formatPct, formatUsdCompact, timeAgo } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { ColorDot } from "@/components/common/AllocationBar";
import { ProtocolLogo } from "@/components/common/ProtocolLogo";
import { Module, ModuleHeader, Skeleton, Badge, Chip, PageTitle, LinkButton } from "@/components/ui/primitives";
import { UsdcEarnModule } from "./UsdcEarnModule";
import { LpPositionsModule } from "./LpPositionsModule";
import { VenueSheet } from "./VenueSheet";
import { ConnectButton } from "@/components/layout/ConnectButton";

type Item = EarnOpportunity & { symbol: string; underlying: string; logoURI?: string };

/** Earn: idle-USDC venues executed in-app + stock-specific opportunities discovered at runtime. */
export function EarnOverview() {
  const { isConnected } = useAccount();
  const { data, isLoading } = useQuery({ queryKey: ["earn", "all"], queryFn: () => apiGet<{ items: Item[]; updatedAt: number; checked?: { assets: number; of: number; providers: string[]; unavailable: string[] } }>("/api/earn"), staleTime: 2 * 60_000 });
  const items = data?.items ?? [];
  const [kind, setKind] = useState<"all" | "earn" | "liquidity" | "borrow">("all");
  const [selected, setSelected] = useState<Item | null>(null);
  const isEarn = (o: Item) => o.type === "supply" || o.type === "vault";
  const counts = { all: items.length, earn: items.filter(isEarn).length, liquidity: items.filter((o) => o.type === "liquidity").length, borrow: items.filter((o) => o.type === "borrow").length };
  const shown = items.filter((o) => kind === "all" || (kind === "earn" ? isEarn(o) : o.type === kind));
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="05 — Earn"
        title="Put idle capital to work."
        lead="Idle USDC earns variable yield in Morpho, Aave and Compound, from here with your wallet. Stock venues appear when they exist."
        action={!isConnected ? <ConnectButton size="lg" /> : <LinkButton href="/portfolio">Portfolio</LinkButton>}
      />

      <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
        {[
          { icon: Sprout, title: "Variable yield", body: "Rates change every block; source and time are shown." },
          { icon: ShieldCheck, title: "Your wallet keeps custody", body: "Deposits land in your address; withdraw when liquidity allows." },
          { icon: Layers, title: "Discovered, not hardcoded", body: "Venues are read onchain at runtime and shown only when they exist." },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="p-4 flex flex-col gap-2">
            <Icon size={18} strokeWidth={1.75} className="text-primary" />
            <div className="font-medium">{title}</div>
            <p className="text-[13px] text-ink-secondary">{body}</p>
          </div>
        ))}
      </div>

      <UsdcEarnModule />
      <LpPositionsModule />

      <Module>
        <ModuleHeader index="S" title="Stock-specific venues" action={data ? <span className="text-[11px] font-mono text-ink-muted">updated {timeAgo(data.updatedAt)}</span> : undefined} />
        <div className="flex gap-2 px-4 py-2 border-b border-line overflow-x-auto scrollbar-none">
          {([["all", "All"], ["earn", "Supply & vaults"], ["liquidity", "Liquidity pools"], ["borrow", "Borrow against stocks"]] as const).map(([id, label]) => (
            <Chip key={id} active={kind === id} onClick={() => setKind(id)} className="whitespace-nowrap">
              {label} · {counts[id]}
            </Chip>
          ))}
        </div>
        {isLoading && (
          <div className="p-4 flex flex-col gap-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        )}
        {!isLoading && items.length === 0 && (
          <p className="px-4 py-6 text-[14px] text-ink-secondary">
            No verified venue for a tokenized stock right now. This list fills in automatically when a Morpho market, Aave reserve or Aerodrome pool appears for one of the stocks.
            <ScanNote checked={data?.checked} />
          </p>
        )}
        {!isLoading && items.length > 0 && shown.length === 0 && (
          <p className="px-4 py-6 text-[14px] text-ink-secondary">
            {kind === "borrow" ? "No lending market accepts a tokenized stock as collateral yet: Morpho markets are queried by collateral asset, Aave V3 and Compound v3 reserve lists are read onchain, and nothing lists a B20 token today." : "No supply market or vault takes a tokenized stock as its asset yet: Morpho vaults, Aave V3 reserves and Compound v3 markets are read at runtime and none lists a B20 token today."}
            <ScanNote checked={data?.checked} />
          </p>
        )}
        {shown.map((o) => (
          <button type="button" key={o.id} onClick={() => setSelected(o)} className="rail w-full text-left grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
            <span className="flex items-center gap-3 min-w-0">
              <ColorDot k={o.assetAddress} />
              <AssetLogo src={o.logoURI} symbol={o.symbol} size={36} />
              <span className="min-w-0">
                <span className="block font-medium text-[14px] truncate">
                  {o.underlying} · {o.title}
                </span>
                <span className="flex gap-2 mt-1">
                  <ProtocolLogo provider={o.provider} size={16} withLabel className="text-[12px] font-medium" />
                  <Badge>{o.type}</Badge>
                  <Badge tone={o.riskLabel === "higher" ? "danger" : "neutral"}>risk {o.riskLabel}</Badge>
                  {o.inApp && <Badge tone="positive">in-app</Badge>}
                </span>
              </span>
            </span>
            <span className="text-right">
              {o.variableApy !== undefined ? (
                <>
                  <span className="block display num text-[18px]">{formatPct(o.variableApy, { sign: false })}</span>
                  <span className="block text-[10px] font-mono uppercase text-ink-muted">{o.type === "borrow" ? "borrow rate" : "variable"} · {timeAgo(o.dataTimestamp)}</span>
                </>
              ) : (
                <span className="block text-[13px] text-ink-secondary">{formatUsdCompact(o.liquidityUsd ?? o.tvlUsd ?? null)} liquidity</span>
              )}
            </span>
          </button>
        ))}
      </Module>
      <VenueSheet o={selected} symbol={selected?.underlying ?? ""} onClose={() => setSelected(null)} showStockLink />
    </div>
  );
}

const SCAN_LABEL: Record<string, string> = { morpho: "Morpho vaults & markets", aave: "Aave V3", compound: "Compound v3", aerodrome: "Aerodrome v2 + Slipstream", uniswap: "Uniswap v3 factory", "geckoterminal-pools": "Uniswap v4 & other pools via GeckoTerminal" };

/** What the discovery run actually scanned, so an empty list reads as "checked, none exists" rather than "not implemented". */
function ScanNote({ checked }: { checked?: { assets: number; of: number; providers: string[]; unavailable: string[] } }) {
  if (!checked) return null;
  const names = checked.providers.map((p) => SCAN_LABEL[p] ?? p).join(", ");
  return (
    <span className="block mt-2 text-[12px] text-ink-muted">
      Scanned {names} for {checked.assets} of {checked.of} stocks. {checked.unavailable.length > 0 ? `${checked.unavailable.map((p) => SCAN_LABEL[p] ?? p).join(", ")} did not answer this run.` : "Every venue answered."}
    </span>
  );
}

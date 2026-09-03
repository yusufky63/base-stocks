"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Landmark, Sprout } from "lucide-react";
import type { Address } from "viem";
import { useEarn } from "@/hooks/queries";
import type { EarnOpportunity } from "@/domain/earn";
import { Badge, Label, Skeleton } from "@/components/ui/primitives";
import { formatPct, formatUsdCompact, timeAgo } from "@/lib/format";
import { TYPE_LABEL, VenueSheet } from "./VenueSheet";
import { ProtocolLogo } from "@/components/common/ProtocolLogo";

interface Props {
  assetAddress: Address;
  user?: Address;
  symbol: string;
  /** Render an honest empty state instead of nothing (stock page). */
  showEmpty?: boolean;
}

/**
 * Earn is opportunistic: nothing is invented (spec §4.7). Venues are split into "earn with" and
 * "borrow against"; each opens the shared VenueSheet (in-app deposit or hand-off to the venue).
 */
export function EarnModule({ assetAddress, user, symbol, showEmpty = false }: Props) {
  const { data, isLoading } = useEarn(assetAddress, user);
  const [selected, setSelected] = useState<EarnOpportunity | null>(null);
  const list = data?.opportunities ?? [];
  const earn = list.filter((o) => o.type !== "borrow");
  const borrow = list.filter((o) => o.type === "borrow");

  if (!showEmpty && (isLoading || list.length === 0)) return null;

  return (
    <div className="p-4 md:p-5 flex flex-col gap-4">
      <Section icon={<Sprout size={12} strokeWidth={2} className="text-primary" />} title={`Earn with ${symbol}`} stamp={data ? `checked ${timeAgo(data.updatedAt)}` : undefined}>
        {isLoading && <Skeleton className="h-16" />}
        {!isLoading && earn.length === 0 && <p className="text-[14px] text-ink-secondary">No verified venue pays yield on {symbol} right now. Morpho vaults, Aave and Compound reserves and Aerodrome/Uniswap pools are checked automatically and appear here the moment one exists.</p>}
        <VenueList items={earn} onPick={setSelected} />
      </Section>

      <Section icon={<Landmark size={12} strokeWidth={2} className="text-primary" />} title={`Borrow against ${symbol}`}>
        {isLoading && <Skeleton className="h-12" />}
        {!isLoading && borrow.length === 0 && <p className="text-[14px] text-ink-secondary">No lending market accepts {symbol} as collateral yet. Morpho markets are checked automatically; a market appears here with its borrow rate when one is created.</p>}
        <VenueList items={borrow} onPick={setSelected} />
      </Section>

      <div className="flex items-center justify-between gap-3 text-[12px] text-ink-muted border-t border-line pt-3">
        <span>Estimated returns are variable and never guaranteed.</span>
        <Link href="/earn" className="inline-flex items-center gap-1 text-primary font-medium whitespace-nowrap">
          Earn page <ArrowUpRight size={12} strokeWidth={2} />
        </Link>
      </div>

      <VenueSheet o={selected} symbol={symbol} onClose={() => setSelected(null)} />
    </div>
  );
}

function Section({ icon, title, stamp, children }: { icon: React.ReactNode; title: string; stamp?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>
          {icon} {title}
        </Label>
        {stamp && <span className="text-[11px] font-mono text-ink-muted">{stamp}</span>}
      </div>
      {children}
    </div>
  );
}

function VenueList({ items, onPick }: { items: EarnOpportunity[]; onPick: (o: EarnOpportunity) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {items.map((o) => (
        <li key={o.id}>
          <button type="button" onClick={() => onPick(o)} className="rail w-full text-left border border-line rounded-[8px] px-3 py-3 hover:border-line-strong transition-fast flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block font-medium text-[14px] truncate">{o.title}</span>
              <span className="flex items-center gap-1.5 mt-1 flex-wrap text-[12px] text-ink-secondary">
                <ProtocolLogo provider={o.provider} size={14} withLabel /> · {TYPE_LABEL[o.type]} · risk {o.riskLabel}
                {o.inApp ? <Badge tone="positive">in-app</Badge> : <Badge>on venue</Badge>}
              </span>
            </span>
            <span className="text-right shrink-0">
              {o.variableApy !== undefined ? (
                <>
                  <span className="block display num text-[18px]">{formatPct(o.variableApy, { sign: false })}</span>
                  <span className="block text-[10px] font-mono uppercase text-ink-muted">{o.type === "borrow" ? "borrow rate" : "variable"} · {timeAgo(o.dataTimestamp)}</span>
                </>
              ) : (
                <span className="block text-[12px] text-ink-secondary">{o.liquidityUsd !== undefined ? `${formatUsdCompact(o.liquidityUsd)} liquidity` : "Available"}</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

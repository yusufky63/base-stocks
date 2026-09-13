"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { HelpCircle } from "lucide-react";
import type { PortfolioPnl } from "@/services/pnl-service";
import { apiGet } from "@/lib/client-api";
import { formatPct, formatTokenAmount, formatUsd } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { Module, ModuleHeader, Skeleton, cx } from "@/components/ui/primitives";

const tone = (v: number) => (v > 0 ? "text-positive-fg" : v < 0 ? "text-danger-fg" : "text-ink-secondary");
const signed = (v: number) => `${v > 0 ? "+" : ""}${formatUsd(v)}`;

/**
 * What the wallet has made, measured against what it paid.
 *
 * Two things this deliberately does not do. It does not spread the cost of a purchase over stock
 * that arrived some other way — a gift or a pool share has no purchase price, and calling it pure
 * profit would be the easiest lie on the page. And it does not quietly drop a trade whose USD value
 * was never recorded; those are counted and named, because a basis missing a leg is worse than one
 * that says so.
 */
export function PnlModule({ address, hasHoldings }: { address: Address; hasHoldings: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["portfolio", "pnl", address.toLowerCase()],
    queryFn: () => apiGet<{ pnl: PortfolioPnl }>(`/api/portfolio/${address}/pnl`).then((r) => r.pnl),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <Module>
        <ModuleHeader index="P" title="Profit and loss" />
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-10" />
        </div>
      </Module>
    );
  }
  if (!data) return null;

  if (data.noTrades) {
    // Nothing bought and nothing held: there is no page to fill in. A holder with no trades gets
    // the explanation; a wallet that sold everything keeps its realised line below.
    if (!hasHoldings) return null;
    return (
      <Module>
        <ModuleHeader index="P" title="Profit and loss" />
        <p className="px-4 py-4 text-[13px] text-ink-secondary">
          Nothing bought here yet, so there is no purchase price to measure against. Buy a stock and this fills in — stock that arrives as a gift or a pool share stays listed separately, because it has no cost behind it.
        </p>
      </Module>
    );
  }

  const total = data.unrealisedUsd + data.realisedUsd;
  const cells: Array<{ label: string; value: string; sub?: string; toneOf?: number }> = [
    { label: "Cost", value: formatUsd(data.costUsd), sub: "what you paid" },
    { label: "Value now", value: formatUsd(data.marketUsd), sub: "same units, today" },
    { label: "Unrealised", value: signed(data.unrealisedUsd), sub: data.unrealisedPct !== null ? formatPct(data.unrealisedPct, { sign: true }) : undefined, toneOf: data.unrealisedUsd },
    { label: "Realised", value: signed(data.realisedUsd), sub: "taken by selling", toneOf: data.realisedUsd },
  ];

  return (
    <Module>
      <ModuleHeader
        index="P"
        title="Profit and loss"
        action={<span className={cx("font-mono num text-[13px]", tone(total))}>{`${signed(total)} all in`}</span>}
      />

      <dl className="grid grid-cols-2 md:grid-cols-4 border-b border-line">
        {cells.map((c) => (
          <div key={c.label} className="px-4 py-3 border-r border-b md:border-b-0 border-line last:border-r-0 md:[&:nth-child(2)]:border-r [&:nth-child(2n)]:border-r-0 md:[&:nth-child(2n)]:border-r md:last:border-r-0">
            <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
            <dd className={cx("display num text-[20px] leading-none mt-1", c.toneOf !== undefined ? tone(c.toneOf) : "")}>{c.value}</dd>
            {c.sub && <dd className="text-[11px] text-ink-muted mt-1">{c.sub}</dd>}
          </div>
        ))}
      </dl>

      <ul>
        {data.holdings
          .filter((h) => h.costUsd > 0 || h.uncoveredRaw !== "0")
          .map((h) => (
            <li key={h.assetAddress} className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0">
              <AssetLogo src={h.logoURI} symbol={h.symbol} size={30} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-[14px]">{h.underlying}</span>
                <span className="block text-[11px] text-ink-muted font-mono num">
                  {h.costUsd > 0 ? `cost ${formatUsd(h.costUsd)} · now ${formatUsd(h.marketUsd)}` : "no purchase recorded here"}
                </span>
              </span>
              <span className="text-right shrink-0">
                {h.costUsd > 0 ? (
                  <>
                    <span className={cx("block display num text-[15px]", tone(h.unrealisedUsd))}>{signed(h.unrealisedUsd)}</span>
                    {h.unrealisedPct !== null && <span className={cx("block font-mono num text-[11px]", tone(h.unrealisedUsd))}>{formatPct(h.unrealisedPct, { sign: true })}</span>}
                  </>
                ) : (
                  <span className="block font-mono text-[11px] text-ink-muted">—</span>
                )}
                {h.uncoveredRaw !== "0" && (
                  <span className="block font-mono text-[10px] text-ink-muted">{`+${formatTokenAmount(BigInt(h.uncoveredScaled), h.decimals)} without a cost`}</span>
                )}
              </span>
            </li>
          ))}
      </ul>

      <p className="px-4 py-3 text-[11px] text-ink-muted border-t border-line flex items-start gap-1.5">
        <HelpCircle size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>
          Average cost, from trades made here.
          {data.uncoveredHoldings > 0 && ` ${data.uncoveredHoldings} holding${data.uncoveredHoldings > 1 ? "s include" : " includes"} stock with no purchase behind it — a gift, a pool share or a transfer — left out of the numbers rather than counted as profit.`}
          {data.unpricedTrades > 0 && ` ${data.unpricedTrades} trade${data.unpricedTrades > 1 ? "s" : ""} went through without a recorded dollar value and ${data.unpricedTrades > 1 ? "are" : "is"} not in the basis.`}
        </span>
      </p>
    </Module>
  );
}

"use client";

import { ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { apiGet, type PoolMapResponse } from "@/lib/client-api";
import { qk } from "@/hooks/queries";
import { formatUsdCompact, timeAgo } from "@/lib/format";
import { Badge, Skeleton, cx } from "@/components/ui/primitives";

/** Liquidity map: every pool GeckoTerminal lists for the stock, and what this app does with each. */
export function PoolsModule({ address }: { address: Address }) {
  const { data, isLoading, isError } = useQuery({ queryKey: qk.pools(address), queryFn: () => apiGet<PoolMapResponse>(`/api/market/${address}/pools`), staleTime: 2 * 60_000 });
  if (isLoading) return <Skeleton className="h-20" />;
  if (isError || !data) return <p className="text-[13px] text-ink-secondary">Pool list unavailable right now.</p>;
  if (data.pools.length === 0) return <p className="text-[13px] text-ink-secondary">No DEX pool reported for this stock yet.</p>;
  const t = data.totals;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12px] text-ink-secondary">
        <span>
          <span className="font-medium text-ink">{t.count}</span> pool{t.count === 1 ? "" : "s"} · {formatUsdCompact(t.liquidityUsd)} liquidity · {formatUsdCompact(t.volume24hUsd)} 24h volume
          {t.known < t.count ? ` · ${t.count - t.known} on venues this app does not route` : ""}
        </span>
        <span className="font-mono text-[11px] text-ink-muted">GeckoTerminal · {timeAgo(data.updatedAt)}</span>
      </div>
      <div className="border border-line rounded-[8px] overflow-hidden">
        <div className="hidden sm:grid grid-cols-[1fr_90px_90px_auto] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          <span>Pool</span>
          <span className="text-right">Liquidity</span>
          <span className="text-right">24h vol</span>
          <span className="text-right w-[28px]" />
        </div>
        <ul className="divide-y divide-line">
          {data.pools.map((p) => (
            <li key={p.address} className={cx("grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_90px_90px_auto] gap-x-3 gap-y-1 px-3 py-2 items-center", !p.known && "opacity-70")}>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium truncate">
                  {p.dexLabel} <span className="text-ink-secondary font-normal">· {p.name}</span>
                  {p.url && (
                    <a href={p.url} target="_blank" rel="noreferrer noopener" aria-label="Open on the venue" className="sm:hidden inline-flex align-middle ml-1.5 text-ink-muted hover:text-ink">
                      <ExternalLink size={12} strokeWidth={1.75} />
                    </a>
                  )}
                </span>
                <span className="flex flex-wrap gap-1 mt-1">
                  {p.primary && <Badge tone="primary">prices from here</Badge>}
                  {p.routes ? <Badge tone="positive">routed</Badge> : <Badge>not routed</Badge>}
                  {p.lpTracked && <Badge>LP tracked</Badge>}
                  {p.inEarn && <Badge>on Earn tab</Badge>}
                </span>
              </span>
              {/* Below sm the column header is gone, so each number carries its own label. */}
              <span className="text-right font-mono num text-[12px] sm:contents">
                <span className="block sm:text-right">
                  <span className="sm:hidden text-[10px] uppercase tracking-[0.1em] text-ink-muted mr-1">liq</span>
                  {formatUsdCompact(p.reserveUsd)}
                </span>
                <span className="block sm:text-right text-ink-secondary">
                  <span className="sm:hidden text-[10px] uppercase tracking-[0.1em] text-ink-muted mr-1">24h</span>
                  {p.volume24hUsd !== null ? formatUsdCompact(p.volume24hUsd) : "—"}
                </span>
              </span>
              <span className="hidden sm:flex justify-end w-[28px]">
                {p.url && (
                  <a href={p.url} target="_blank" rel="noreferrer noopener" aria-label="Open on the venue" className="text-ink-muted hover:text-ink">
                    <ExternalLink size={13} strokeWidth={1.75} />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[11px] text-ink-muted">Reserves and volume as GeckoTerminal reports them; this app does not re-check them against the pools onchain. &ldquo;Routed&rdquo; means the trade comparison can reach the pool through KyberSwap, Velora or the Uniswap API; &ldquo;LP tracked&rdquo; means positions in it appear under Earn and on this page.</p>
    </div>
  );
}

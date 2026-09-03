"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { ExternalLink } from "lucide-react";
import { useLpPositions } from "@/hooks/queries";
import { formatUsd, timeAgo } from "@/lib/format";
import { Module, ModuleHeader, Badge, Skeleton, cx } from "@/components/ui/primitives";
import { ColorDot } from "@/components/common/AllocationBar";
import { LpManageSheet } from "./LpManageSheet";
import type { LpPositionDTO } from "@/lib/client-api";


const fmtAmt = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 4 : 6 }));

/**
 * Your LP positions (Aerodrome Slipstream, Uniswap v3) that hold a tokenized stock — read-only:
 * value, range, in/out-of-range and uncollected fees, managed on the venue for now.
 */
export function LpPositionsModule({ compact = false }: { compact?: boolean }) {
  const { address } = useAccount();
  const { data, isLoading, isError } = useLpPositions(address);
  const [managing, setManaging] = useState<LpPositionDTO | null>(null);
  const positions = data?.positions ?? [];
  if (!address) return null;
  if (compact && !isLoading && positions.length === 0) return null;
  const total = positions.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  const fees = positions.reduce((s, p) => s + (p.fees.usd ?? 0), 0);

  return (
    <Module>
      <ModuleHeader title="Liquidity positions" action={data ? <span className="font-mono text-[11px] text-ink-muted">{positions.length > 0 ? `${formatUsd(total)} · fees ${formatUsd(fees)} · ` : ""}read {timeAgo(data.readAt)}</span> : undefined} />
      {isLoading && !data && (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-12" />
        </div>
      )}
      {isError && <p className="px-4 py-4 text-[13px] text-danger-fg">Positions could not be read.</p>}
      {data && positions.length === 0 && <p className="px-4 py-4 text-[13px] text-ink-secondary">No liquidity positions with a tokenized stock in this wallet. Pools are listed under each stock&apos;s “Earn or borrow” module.</p>}
      {positions.map((p) => {
        const stock = [p.token0, p.token1].find((t) => t.symbol !== "USDC" && t.symbol !== "WETH") ?? p.token0;
        return (
          <div key={`${p.manager}-${p.tokenId}`} className="px-4 py-3 border-b border-line last:border-b-0 flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-[14px] inline-flex items-center gap-2">
                  <ColorDot k={stock.address} /> {p.token0.symbol} / {p.token1.symbol}
                  <span className="font-mono text-[11px] text-ink-muted">{p.provider === "uniswap" ? `${(p.feeOrTickSpacing / 10_000).toFixed(2).replace(/0$/, "")}% fee` : `tick ${p.feeOrTickSpacing}`}</span>
                </div>
                <div className="text-[12px] text-ink-secondary">
                  {p.managerLabel} · #{p.tokenId}
                  {p.rangeUsd ? (p.rangeUsd.upper > 1e9 || p.rangeUsd.lower < 1e-6 ? " · full range" : ` · range ${formatUsd(p.rangeUsd.lower)} – ${formatUsd(p.rangeUsd.upper)} per ${stock.symbol}`) : ""}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="display num text-[16px]">{p.valueUsd !== null ? formatUsd(p.valueUsd) : "—"}</div>
                <Badge tone={p.inRange ? "positive" : "warning"}>{p.inRange ? "in range" : "out of range"}</Badge>
              </div>
            </div>
            {p.rangeUsd && p.rangeUsd.upper <= 1e9 && (
              <div className="relative h-1.5 rounded-full bg-surface-muted overflow-hidden" aria-hidden>
                {(() => {
                  const span = p.rangeUsd.upper - p.rangeUsd.lower || 1;
                  const pos = Math.min(1, Math.max(0, (p.rangeUsd.current - p.rangeUsd.lower) / span));
                  return (
                    <>
                      <div className={cx("absolute inset-y-0 left-0 right-0", p.inRange ? "bg-positive-fg/30" : "bg-warning-fg/30")} />
                      <div className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${pos * 100}%` }} />
                    </>
                  );
                })()}
              </div>
            )}
            {!p.inRange && <p className="text-[12px] text-warning-fg">Out of range: the position sits in one token and earns no fees until the price re-enters the range.</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-secondary font-mono">
              <span>
                {fmtAmt(p.amount0)} {p.token0.symbol} · {fmtAmt(p.amount1)} {p.token1.symbol}
              </span>
              <span>
                fees {fmtAmt(p.fees.amount0)} {p.token0.symbol} + {fmtAmt(p.fees.amount1)} {p.token1.symbol}
                {p.fees.usd !== null ? ` (${formatUsd(p.fees.usd)})` : ""}
              </span>
              <span className="inline-flex items-center gap-3">
                <button type="button" onClick={() => setManaging(p)} className="text-primary font-medium hover:underline">
                  Collect / withdraw
                </button>
                <a href={p.manageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-ink-muted hover:text-ink">
                  {p.provider === "uniswap" ? "Uniswap" : "Aerodrome"} <ExternalLink size={12} strokeWidth={1.75} />
                </a>
              </span>
            </div>
          </div>
        );
      })}
      {positions.length > 0 && <p className="px-4 py-3 text-[12px] text-ink-muted border-t border-line">Values use current pool prices; fees are what a collect would pay right now. Collect fees and withdraw right here; opening a new position still happens on the venue.</p>}
      {managing && <LpManageSheet open onClose={() => setManaging(null)} position={managing} />}
    </Module>
  );
}

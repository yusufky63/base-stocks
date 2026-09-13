"use client";

import Link from "next/link";
import { ArrowUpRight, Send } from "lucide-react";
import type { B20AssetDTO } from "@/domain/asset";
import { formatTokenAmount, formatUsd, bpsToPct } from "@/lib/format";
import { equityPricePerShare, multiplierToNumber, rawValueUsd } from "@/lib/b20/math";
import { Button } from "@/components/ui/primitives";
import { ColorDot } from "@/components/common/AllocationBar";
import { PriceChange } from "@/components/common/display";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { isNotIssued } from "@/lib/trading-status";

interface Props {
  asset: B20AssetDTO;
  raw: bigint;
  scaled: bigint;
  priceUsd: number | null;
  /** Already gated by the caller (`hasMeaningfulChange`): null when the market is too thin for a daily move to mean anything. */
  change24hPct: number | null;
  /** Share of the user's portfolio in bps, when known. */
  portfolioWeightBps?: number;
  connected: boolean;
  onBuy: () => void;
  onSend: () => void;
  /** This wallet's liquidity positions that contain the stock (Uniswap v3 / Aerodrome Slipstream). */
  lp?: LpSummary | null;
}

export interface LpSummary {
  count: number;
  stockAmount: number;
  quoteText: string;
  valueUsd: number | null;
  feesUsd: number | null;
  inRange: number;
}

/**
 * Today's change in value, from the value now and the day's move. A move at or below -100% has no
 * "value a day ago" (division by zero or a negative), and a pool can report exactly that on the
 * day it opens; such a move is not a number about the position.
 */
export function dayPnlUsd(valueUsd: number | null, change24hPct: number | null): number | null {
  if (valueUsd === null || change24hPct === null || !Number.isFinite(change24hPct) || change24hPct <= -100) return null;
  return valueUsd - valueUsd / (1 + change24hPct / 100);
}

/** "Your position": share-equivalents from scaledBalanceOf, value from raw × token price. */
export function PositionModule({ asset, raw, scaled, priceUsd, change24hPct, portfolioWeightBps, connected, onBuy, onSend, lp }: Props) {
  const multiplierWad = BigInt(asset.multiplier);
  const valueUsd = priceUsd !== null ? rawValueUsd(raw, asset.decimals, priceUsd) : null;
  const multiplier = multiplierToNumber(multiplierWad);
  const dayPnl = dayPnlUsd(valueUsd, change24hPct);

  return (
    <div className="p-4 md:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">
          <ColorDot k={asset.address} /> Your position
        </span>
        {portfolioWeightBps !== undefined && raw > 0n && <span className="font-mono text-[11px] text-ink-muted">{bpsToPct(portfolioWeightBps)} of portfolio</span>}
      </div>

      {raw === 0n ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-ink-secondary">{connected ? (lp && lp.count > 0 ? `No ${asset.underlying} in your wallet right now; your ${asset.underlying} sits in a liquidity pool (below).` : `You don’t hold ${asset.underlying} yet.`) : `Connect a wallet to see your ${asset.underlying} position.`}</p>
          <Button size="md" onClick={onBuy} disabled={asset.status === "paused" || isNotIssued(asset)}>
            Buy {asset.underlying} <ArrowUpRight size={16} strokeWidth={1.75} />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="display num text-[34px] leading-none">
                {formatTokenAmount(scaled, asset.decimals)} <span className="text-[14px] text-ink-secondary font-mono tracking-normal font-normal">{asset.underlying}</span>
              </div>
              <div className="text-[12px] text-ink-muted mt-1 font-mono">share-equivalents{multiplier !== 1 ? ` · ${formatTokenAmount(raw, asset.decimals)} tokens × ${multiplier.toFixed(4)}` : ""}</div>
            </div>
            <div className="text-right">
              <div className="display num text-[26px] leading-none">
                {/* The tween keeps its last number when the value goes away; "—" is the honest state. */}
                {valueUsd === null ? "—" : <AnimatedNumber value={valueUsd} format={(v) => formatUsd(v)} />}
              </div>
              <div className="text-[12px] font-mono mt-1">
                <PriceChange value={change24hPct} /> <span className="text-ink-muted">24h</span>
              </div>
            </div>
          </div>

          <div className="module-grid grid-cols-3">
            <div className="p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Price / share</div>
              <div className="num text-[15px] font-medium">{priceUsd !== null ? formatUsd(equityPricePerShare(priceUsd, multiplierWad)) : "—"}</div>
            </div>
            <div className="p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Today</div>
              <div className="num text-[15px] font-medium">{dayPnl !== null ? `${dayPnl >= 0 ? "+" : "−"}${formatUsd(Math.abs(dayPnl))}` : "—"}</div>
            </div>
            <div className="p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Status</div>
              <div className="text-[13px] font-medium">{asset.status === "paused" ? "Transfers paused" : "Transferable"}</div>
            </div>
          </div>

          <Button size="md" variant="secondary" onClick={onSend} disabled={asset.status === "paused"}>
            <Send size={14} strokeWidth={1.75} /> Send to a wallet or Basename
          </Button>
        </>
      )}
      {lp && lp.count > 0 && (
        <div className="border border-line rounded-[8px] px-3 py-2.5 flex items-center justify-between gap-3 text-[13px]">
          <span className="min-w-0">
            <span className="block font-medium">In liquidity pools</span>
            <span className="block text-[12px] text-ink-secondary truncate">
              {lp.stockAmount.toLocaleString("en-US", { maximumFractionDigits: 4 })} {asset.underlying}
              {lp.quoteText ? ` + ${lp.quoteText}` : ""} · {lp.count} position{lp.count > 1 ? "s" : ""} · {lp.inRange} in range{lp.feesUsd ? ` · fees ${formatUsd(lp.feesUsd)}` : ""}
            </span>
          </span>
          <span className="text-right shrink-0">
            <span className="block display num text-[16px]">{formatUsd(lp.valueUsd)}</span>
            <Link href="/earn" className="text-[12px] text-primary font-medium">
              Manage →
            </Link>
          </span>
        </div>
      )}
      <p className="text-[12px] text-ink-muted">Held in your wallet, not by BaseStocks. Issuer policies and pauses are checked before every trade or transfer.</p>
    </div>
  );
}

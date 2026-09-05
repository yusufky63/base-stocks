"use client";

import type { Address } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation } from "@/domain/portfolio";
import { tradingStatus } from "@/lib/trading-status";
import { AssetLogo } from "@/components/common/display";
import { cx } from "@/components/ui/primitives";

/** Equal weights across the stock legs; a cash leg keeps its share. */
export function equalStocks(list: Allocation[]): Allocation[] {
  const cash = list.find((a) => a.assetAddress === USDC_ALLOCATION_KEY);
  const stocks = list.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
  if (stocks.length === 0) return cash ? [cash] : [];
  const pool = TOTAL_BPS - (cash?.weightBps ?? 0);
  const per = Math.floor(pool / stocks.length);
  const rem = pool - per * stocks.length;
  return [...stocks.map((a, i) => ({ ...a, weightBps: per + (i === 0 ? rem : 0) })), ...(cash ? [cash] : [])];
}

/**
 * Tap the stocks you want. Each tap adds or removes a leg and re-spreads the stock weights evenly
 * (a cash leg keeps its share); the editor below is where the weights get tuned. Only stocks that
 * can be bought today are offered; the rest are shown muted with the reason, never hidden.
 */
export function StockPicker({
  assets,
  prices,
  value,
  onChange,
  disabled = false,
  columns = "grid-cols-3 sm:grid-cols-4 lg:grid-cols-5",
}: {
  assets: B20AssetDTO[];
  prices?: Record<string, PriceView>;
  value: Allocation[];
  onChange: (next: Allocation[]) => void;
  disabled?: boolean;
  columns?: string;
}) {
  const picked = new Set(value.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY).map((a) => (a.assetAddress as string).toLowerCase()));
  const toggle = (address: Address) => {
    if (disabled) return;
    const key = address.toLowerCase();
    onChange(equalStocks(picked.has(key) ? value.filter((a) => (a.assetAddress as string).toLowerCase() !== key) : [...value, { assetAddress: address, weightBps: 0 }]));
  };
  const rows = assets
    .filter((a) => a.status === "active")
    .map((a) => ({ a, status: tradingStatus(a, prices?.[a.canonicalId]) }))
    .sort((x, y) => x.status.rank - y.status.rank);
  return (
    <div className={cx("grid gap-1.5", columns)}>
      {rows.map(({ a, status }) => {
        const on = picked.has(a.canonicalId);
        const blocked = status.status === "not-issued" || status.status === "no-pool" || status.status === "paused";
        return (
          <button
            key={a.canonicalId}
            type="button"
            aria-pressed={on}
            disabled={disabled || blocked}
            title={blocked ? status.detail : status.status === "very-thin" || status.status === "thin" ? status.detail : undefined}
            onClick={() => toggle(a.address as Address)}
            className={cx(
              "h-10 px-2 rounded-[6px] border text-[12px] font-medium transition-fast inline-flex items-center gap-1.5 min-w-0",
              on ? "border-primary text-primary bg-primary-soft" : "border-line text-ink-secondary hover:border-line-strong hover:text-ink",
              blocked && "opacity-45 cursor-not-allowed",
            )}
          >
            <AssetLogo src={a.logoURI} symbol={a.symbol} size={18} />
            <span className="truncate">{a.underlying}</span>
            {status.status !== "tradable" && <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.06em] text-warning-fg shrink-0">{status.status === "not-issued" ? "soon" : status.status === "no-pool" ? "no pool" : status.status === "paused" ? "paused" : "thin"}</span>}
          </button>
        );
      })}
      {rows.length === 0 && <span className="text-[12px] text-ink-muted col-span-full">No stocks available right now.</span>}
    </div>
  );
}

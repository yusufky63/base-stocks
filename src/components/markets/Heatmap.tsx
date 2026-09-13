"use client";

import { useMemo } from "react";
import Link from "next/link";
import { hasMeaningfulChange, tradingStatus } from "@/lib/trading-status";
import { formatPct, formatUsd, formatUsdCompact } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { liveMarketRows, type MarketRow } from "./live-markets";

/**
 * Colour by the day's move, with intensity by its size: a 0.5% move is barely tinted, a 5% move
 * is as deep as the tint goes. The tint is a translucent overlay of the semantic colour on the
 * surface, capped at 50% so the page's own text colour still reads on it in both themes — no
 * grey on green. Never colour alone: the signed figure sits on every tile.
 */
function tileStyle(changePct: number | null): { background: string; color: string } {
  if (changePct === null) return { background: "var(--surface-muted)", color: "var(--text)" };
  const strength = Math.min(1, Math.abs(changePct) / 5);
  const alpha = 0.1 + strength * 0.4;
  const tone = changePct > 0 ? "var(--positive-fg)" : changePct < 0 ? "var(--danger-fg)" : "var(--text-muted)";
  return { background: `color-mix(in oklab, ${tone} ${Math.round(alpha * 100)}%, var(--surface))`, color: "var(--text)" };
}

/**
 * The Markets heatmap, an alternative view of the same list: one tile per stock, coloured by the
 * 24h move and sized by DEX liquidity — the three deepest markets take double tiles, so the eye
 * lands where the money is. Computed from the assets response the page already holds.
 */
export function Heatmap({ rows }: { rows: MarketRow[] }) {
  const ranked = useMemo(() => {
    const byLiq = [...rows].sort((a, b) => (b.price?.liquidityUsd ?? 0) - (a.price?.liquidityUsd ?? 0));
    const big = new Set(byLiq.filter((r) => (r.price?.liquidityUsd ?? 0) > 0).slice(0, 3).map((r) => r.asset.canonicalId));
    return byLiq.map((r) => ({ ...r, big: big.has(r.asset.canonicalId) }));
  }, [rows]);

  const liveCount = liveMarketRows(rows).length;
  const moves = rows.map((r) => (hasMeaningfulChange(tradingStatus(r.asset, r.price).status, r.price) ? (r.price?.marketChange24hPct ?? null) : null)).filter((v): v is number => v !== null);
  const avg = moves.length ? moves.reduce((s, v) => s + v, 0) / moves.length : null;

  return (
    <section className="border border-line rounded-[8px] bg-canvas overflow-hidden ticks" aria-label="Market heatmap">
      <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">24h move · size by liquidity</span>
        <span className="font-mono num text-[12px] text-ink-secondary whitespace-nowrap">
          {rows.length} {rows.length === 1 ? "stock" : "stocks"} · {liveCount} live{avg !== null ? ` · avg ${formatPct(avg, { sign: true })}` : ""}
        </span>
      </div>
      {ranked.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">No stocks match.</p>
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-px bg-line" style={{ gridAutoFlow: "dense" }}>
          {ranked.map(({ asset, price, big }) => {
            const view = tradingStatus(asset, price);
            const change = hasMeaningfulChange(view.status, price) ? (price?.marketChange24hPct ?? null) : null;
            return (
              <li key={asset.canonicalId} className={cx("min-w-0", big && "col-span-2 row-span-2")}>
                <Link
                  href={`/stocks/${asset.address}`}
                  className={cx("block h-full min-h-[76px] p-2.5 sm:p-3 transition-fast hover:brightness-[1.06] focus-visible:outline-2 focus-visible:outline-primary", big && "min-h-[156px]")}
                  style={tileStyle(change)}
                  title={`${asset.underlying} · ${view.label}${price?.liquidityUsd ? ` · liquidity ${formatUsdCompact(price.liquidityUsd)}` : ""}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cx("font-medium leading-none", big ? "text-[20px]" : "text-[14px]")}>{asset.underlying}</span>
                    {/* The status's own label, so "Very thin" and "No pool yet" are not both printed as "not issued". */}
                    {view.status !== "tradable" && <span className={cx("font-mono text-[11px] uppercase tracking-[0.06em] truncate", change === null ? "text-ink-muted" : "opacity-85")}>{view.label}</span>}
                  </span>
                  <span className={cx("block font-mono num leading-none mt-1.5", big ? "text-[18px]" : "text-[13px]", change === null && "text-ink-muted")}>{change === null ? "—" : formatPct(change, { sign: true })}</span>
                  <span className={cx("block font-mono num mt-1", big ? "text-[12px]" : "text-[11px]", change === null ? "text-ink-secondary" : "opacity-90")}>{price?.displayUsd != null ? formatUsd(price.displayUsd) : "—"}</span>
                  {big && price?.liquidityUsd ? <span className={cx("block font-mono num text-[11px] mt-2", change === null ? "text-ink-secondary" : "opacity-90")}>liq {formatUsdCompact(price.liquidityUsd)}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-4 py-2 border-t border-line text-[11px] text-ink-muted">Colour is the 24h move on the DEX price, deeper the larger the move; the three deepest markets take the big tiles. Tap a tile to open the stock.</p>
    </section>
  );
}

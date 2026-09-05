"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { AssetsResponse } from "@/lib/client-api";
import type { MarketTag } from "@/domain/asset";
import { hasMeaningfulChange, tradingStatus, type TradingStatus } from "@/lib/trading-status";
import { formatPct, formatUsd, formatUsdCompact } from "@/lib/format";
import { Chip, cx } from "@/components/ui/primitives";

export type StatusFilter = "all" | "live" | "thin" | "not-issued";

export interface ScreenerFilters {
  tag: MarketTag | "all";
  status: StatusFilter;
}

export const TAG_LABEL: Record<MarketTag, string> = { technology: "Technology", ai: "AI", finance: "Finance", crypto: "Crypto", semiconductors: "Semiconductors", other: "Other" };

type Row = { asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string] };

function statusBucket(status: TradingStatus): StatusFilter {
  if (status === "tradable") return "live";
  if (status === "thin") return "thin";
  return "not-issued";
}

/** The screener rule, shared by the heatmap and the table so they never disagree about what is shown. */
export function applyFilters(rows: Row[], f: ScreenerFilters): Row[] {
  return rows.filter(({ asset, price }) => {
    if (f.tag !== "all" && !asset.tags.includes(f.tag)) return false;
    if (f.status !== "all" && statusBucket(tradingStatus(asset, price).status) !== f.status) return false;
    return true;
  });
}

/**
 * Colour by the day's move, with intensity by its size: a 0.5% move is barely tinted, a 5% move is
 * fully painted. The tint is a translucent overlay of the semantic colour, so it reads on both
 * themes without a second palette. Never colour alone: the signed figure sits on every tile.
 */
function tileStyle(changePct: number | null): { background: string; color?: string } {
  if (changePct === null) return { background: "var(--surface-muted)" };
  const strength = Math.min(1, Math.abs(changePct) / 5);
  const alpha = 0.12 + strength * 0.68;
  const tone = changePct > 0 ? "var(--positive-fg)" : changePct < 0 ? "var(--danger-fg)" : "var(--text-muted)";
  return { background: `color-mix(in oklab, ${tone} ${Math.round(alpha * 100)}%, var(--surface))` };
}

/**
 * The Markets heatmap: one tile per stock, coloured by the 24h move and sized by DEX liquidity —
 * the three deepest markets take double tiles, so the eye lands where the money is. Computed from
 * the assets response the page already holds; no request of its own.
 */
export function Heatmap({ rows, filters, onFilters }: { rows: Row[]; filters: ScreenerFilters; onFilters: (f: ScreenerFilters) => void }) {
  const tags = useMemo(() => {
    const seen = new Set<MarketTag>();
    for (const r of rows) for (const t of r.asset.tags) seen.add(t);
    return (Object.keys(TAG_LABEL) as MarketTag[]).filter((t) => seen.has(t));
  }, [rows]);

  const shown = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const ranked = useMemo(() => {
    const byLiq = [...shown].sort((a, b) => (b.price?.liquidityUsd ?? 0) - (a.price?.liquidityUsd ?? 0));
    const big = new Set(byLiq.filter((r) => (r.price?.liquidityUsd ?? 0) > 0).slice(0, 3).map((r) => r.asset.canonicalId));
    return byLiq.map((r) => ({ ...r, big: big.has(r.asset.canonicalId) }));
  }, [shown]);

  const liveCount = shown.filter((r) => {
    const s = tradingStatus(r.asset, r.price).status;
    return s === "tradable" || s === "thin";
  }).length;
  const avg = (() => {
    const moves = shown.map((r) => (hasMeaningfulChange(tradingStatus(r.asset, r.price).status, r.price) ? (r.price?.marketChange24hPct ?? null) : null)).filter((v): v is number => v !== null);
    return moves.length ? moves.reduce((s, v) => s + v, 0) / moves.length : null;
  })();

  return (
    <section className="border border-line rounded-[8px] bg-canvas overflow-hidden" aria-label="Market heatmap">
      <div className="px-4 py-3 border-b border-line flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted mr-1">Screen</span>
        <Chip active={filters.status === "all"} onClick={() => onFilters({ ...filters, status: "all" })} className="h-8 min-h-[32px] px-2.5 text-[12px]">
          All
        </Chip>
        {(["live", "thin", "not-issued"] as const).map((s) => (
          <Chip key={s} active={filters.status === s} onClick={() => onFilters({ ...filters, status: filters.status === s ? "all" : s })} className="h-8 min-h-[32px] px-2.5 text-[12px]">
            {s === "live" ? "Live" : s === "thin" ? "Thin" : "Not issued"}
          </Chip>
        ))}
        <span className="w-px h-5 bg-line mx-1" aria-hidden />
        {tags.map((t) => (
          <Chip key={t} active={filters.tag === t} onClick={() => onFilters({ ...filters, tag: filters.tag === t ? "all" : t })} className="h-8 min-h-[32px] px-2.5 text-[12px]">
            {TAG_LABEL[t]}
          </Chip>
        ))}
        <span className="ml-auto font-mono num text-[12px] text-ink-secondary whitespace-nowrap">
          {shown.length} {shown.length === 1 ? "stock" : "stocks"} · {liveCount} live{avg !== null ? ` · avg ${formatPct(avg, { sign: true })}` : ""}
        </span>
      </div>
      {ranked.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">No stock matches this screen.</p>
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-px bg-line" style={{ gridAutoFlow: "dense" }}>
          {ranked.map(({ asset, price, big }) => {
            const view = tradingStatus(asset, price);
            const change = hasMeaningfulChange(view.status, price) ? (price?.marketChange24hPct ?? null) : null;
            const style = tileStyle(change);
            return (
              <li key={asset.canonicalId} className={cx("min-w-0", big && "col-span-2 row-span-2")}>
                <Link
                  href={`/stocks/${asset.address}`}
                  className={cx("block h-full min-h-[76px] p-2.5 sm:p-3 transition-fast hover:brightness-[1.06] focus-visible:outline-2 focus-visible:outline-primary", big && "min-h-[156px]")}
                  style={style}
                  title={`${asset.underlying} · ${view.label}${price?.liquidityUsd ? ` · liquidity ${formatUsdCompact(price.liquidityUsd)}` : ""}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cx("font-medium leading-none", big ? "text-[20px]" : "text-[14px]")}>{asset.underlying}</span>
                    {view.status !== "tradable" && <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted truncate">{view.status === "thin" ? "thin" : view.status === "paused" ? "paused" : "not issued"}</span>}
                  </span>
                  <span className={cx("block font-mono num leading-none mt-1.5", big ? "text-[18px]" : "text-[13px]", change === null ? "text-ink-muted" : "text-ink")}>{change === null ? "—" : formatPct(change, { sign: true })}</span>
                  <span className={cx("block font-mono num text-ink-secondary mt-1", big ? "text-[12px]" : "text-[10px]")}>{price?.displayUsd != null ? formatUsd(price.displayUsd) : "—"}</span>
                  {big && price?.liquidityUsd ? <span className="block font-mono num text-[11px] text-ink-secondary mt-2">liq {formatUsdCompact(price.liquidityUsd)}</span> : null}
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

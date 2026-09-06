"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronsUpDown, ChevronUp, Search, Star } from "lucide-react";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { useAssets, useRegion, useSparklines, useWatchlist } from "@/hooks/queries";
import type { AssetsResponse } from "@/lib/client-api";
import { formatUsd, formatUsdCompact } from "@/lib/format";
import { hasMeaningfulChange, sortByTradingStatus, tradingStatus, type TradingStatusView } from "@/lib/trading-status";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { TimeAgo } from "@/components/common/TimeAgo";
import { RegionNotice } from "@/components/common/RegionNotice";
import { PageTitle, Skeleton, cx } from "@/components/ui/primitives";
import { assetColor } from "@/lib/colors";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Sparkline } from "@/components/ui/Sparkline";
import { Heatmap } from "./Heatmap";
import { MarketClock } from "@/components/layout/MarketClock";
import { Segmented } from "@/components/ui/Segmented";
import { useMarketsView, type MarketsView as MarketsViewMode } from "@/hooks/useSettings";

type SortKey = "default" | "price" | "change24h" | "liquidity";

const DOT: Record<TradingStatusView["tone"], string> = { positive: "bg-positive-fg", warning: "bg-warning-fg", neutral: "bg-ink-muted", danger: "bg-danger-fg" };
const TEXT: Record<TradingStatusView["tone"], string> = { positive: "text-positive-fg", warning: "text-warning-fg", neutral: "text-ink-muted", danger: "text-danger-fg" };

/** Compact status chip: dot + label, detail on hover. Same component on the row and on mobile cards. */
export function StatusChip({ view, className }: { view: TradingStatusView; className?: string }) {
  return (
    <span title={view.detail} className={cx("inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]", TEXT[view.tone], className)}>
      <span className={cx("inline-block w-1.5 h-1.5 rounded-full", DOT[view.tone])} aria-hidden />
      {view.label}
      {/* Liquidity shows on mobile only; the desktop table has a dedicated Liquidity column, so it would be a duplicate there. */}
      {view.status === "tradable" || view.status === "thin" ? <span className="md:hidden text-ink-muted normal-case tracking-normal">· {view.detail.split(" ·")[0]}</span> : null}
    </span>
  );
}

/** A right-aligned, sortable column header: clicking cycles default → high-to-low → low-to-high. */
function SortHeader({ label, col, sort, onSort }: { label: string; col: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (k: SortKey) => void }) {
  const active = sort.key === col;
  return (
    <button type="button" onClick={() => onSort(col)} className={cx("inline-flex items-center gap-1 justify-end w-full font-mono text-[11px] uppercase tracking-[0.12em] transition-fast", active ? "text-ink" : "text-ink-muted hover:text-ink")}>
      {label}
      {active ? sort.dir === "asc" ? <ChevronUp size={11} strokeWidth={2} /> : <ChevronDown size={11} strokeWidth={2} /> : <ChevronsUpDown size={11} strokeWidth={2} className="opacity-30" />}
    </button>
  );
}

export function MarketsView({ initialData }: { initialData?: AssetsResponse }) {
  const { data, isLoading, isError } = useAssets(initialData);
  const { data: sparks } = useSparklines();
  const { address } = useAccount();
  const watchlist = useWatchlist(address);
  const region = useRegion();
  const restricted = region.data?.restricted === true;
  const [query, setQuery] = useState("");
  const { view, setView } = useMarketsView();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "default", dir: "desc" });
  // Click cycles a column: unsorted → high-to-low → low-to-high → back to the default status order.
  const onSort = (key: SortKey) => setSort((s) => (s.key !== key ? { key, dir: "desc" } : s.dir === "desc" ? { key, dir: "asc" } : { key: "default", dir: "desc" }));

  const all = useMemo(() => (data ? sortByTradingStatus(data.assets.map((a) => ({ asset: a, price: data.prices[a.canonicalId] })), (x) => x) : []), [data]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q ? all.filter(({ asset }) => asset.symbol.toLowerCase().includes(q) || asset.name.toLowerCase().includes(q) || asset.underlying.toLowerCase().includes(q)) : all;
    if (sort.key !== "default") {
      const val = (p?: AssetsResponse["prices"][string]) => (sort.key === "price" ? p?.displayUsd : sort.key === "change24h" ? p?.marketChange24hPct : p?.liquidityUsd);
      list = [...list].sort((a, b) => {
        const av = val(a.price);
        const bv = val(b.price);
        if (av == null && bv == null) return 0;
        if (av == null) return 1; // a missing value sinks to the bottom, whichever way we sort
        if (bv == null) return -1;
        return sort.dir === "asc" ? av - bv : bv - av;
      });
    }
    return list;
  }, [all, query, sort]);

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        index="02 — Markets"
        title="Markets"
        lead={
          <span className="inline-flex items-center gap-2 flex-wrap">
            <span className="live-dot" /> Live · {data ? <>updated <TimeAgo value={data.readAt} placeholder="just now" /></> : "loading"}
            <MarketClock className="text-ink-muted before:content-['·'] before:mr-2" />
          </span>
        }
        action={
          <label className="flex items-center h-11 w-full md:w-[320px] rounded-[6px] border border-line-strong bg-canvas px-3 gap-2 focus-within:border-primary transition-fast">
            <Search size={16} strokeWidth={1.75} className="text-ink-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search stocks" aria-label="Search stocks" className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-ink-muted" />
          </label>
        }
      />

      {restricted && region.data && <RegionNotice region={region.data} compact />}
      {data && <MarketStats rows={all} />}
      <div className="flex items-center justify-end">
        <Segmented<MarketsViewMode> size="sm" className="w-[200px]" ariaLabel="How to show the markets" value={view} onChange={setView} options={[{ value: "list", label: "List" }, { value: "heatmap", label: "Heatmap" }]} />
      </div>
      {view === "heatmap" && data && <Heatmap rows={rows} />}
      <div className={cx("border border-line rounded-[8px] overflow-hidden bg-canvas ticks", view === "heatmap" && "hidden")}>
        <div className="hidden md:grid grid-cols-[1fr_96px_130px_96px_130px_120px_150px] gap-3 px-4 py-2 border-b border-line font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted whitespace-nowrap items-center">
          <span>Stock</span>
          <span className="text-right">7d</span>
          <SortHeader label="Price" col="price" sort={sort} onSort={onSort} />
          <SortHeader label="24h" col="change24h" sort={sort} onSort={onSort} />
          <SortHeader label="Liq · vol" col="liquidity" sort={sort} onSort={onSort} />
          <span className="text-right">Reference</span>
          <span />
        </div>
        {isLoading && !data && (
          <div className="p-4 flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}
        {isError && !data && <p className="p-4 text-[14px] text-ink-secondary">Markets are temporarily unavailable. Please try again.</p>}
        {rows.map(({ asset, price }) => (
          <MarketRow key={asset.canonicalId} asset={asset} price={price} spark={sparks?.series[asset.canonicalId]} watched={watchlist.has(asset.address)} onToggleWatch={address ? () => watchlist.toggle(asset.address as Address) : undefined} restricted={restricted} />
        ))}
        {data && rows.length === 0 && <p className="p-4 text-[14px] text-ink-secondary">{query ? `No stocks match “${query}”.` : "No stocks match."}</p>}
      </div>
      <p className="text-[12px] text-ink-muted">Live = a DEX pool with $100k+ liquidity; Thin = $10k–100k; Not issued yet = the contract exists but Coinbase has not minted tokens on Base. Price is the DEX market price when a pool exists, otherwise the Chainlink reference (marked). Executable prices come from a live quote when you trade.</p>
    </div>
  );
}

function MarketRow({ asset, price, spark, watched, onToggleWatch, restricted }: { asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string]; spark?: number[]; watched: boolean; onToggleWatch?: () => void; restricted: boolean }) {
  const display = price?.displayUsd ?? null;
  const view = tradingStatus(asset, price);
  const tradable = view.status === "tradable" || view.status === "thin";
  const muted = view.status === "not-issued" || view.status === "paused";
  return (
    <div className={cx("rail grid grid-cols-[1fr_auto] md:grid-cols-[1fr_96px_130px_96px_130px_120px_150px] items-center px-4 py-3 border-b border-line last:border-b-0 gap-3 hover:bg-surface transition-fast", muted && "opacity-75 hover:opacity-100")}>
      <Link href={`/stocks/${asset.address}`} className="flex items-center gap-3 min-w-0">
        <span className="w-1 self-stretch rounded-full" style={{ background: assetColor(asset.address) }} aria-hidden />
        <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={36} />
        <span className="min-w-0">
          <span className="block font-medium text-[15px] leading-tight">
            {asset.underlying} <span className="text-ink-muted font-mono text-[11px]">{asset.symbol}</span>
          </span>
          <span className="block text-[13px] text-ink-secondary truncate">{asset.name}</span>
          {/* "Live" is the norm and the desktop table has its own columns, so only flag it on mobile; thin/paused/not-issued always show. */}
          <StatusChip view={view} className={cx("mt-0.5", view.status === "tradable" && "md:hidden")} />
        </span>
      </Link>
      <div className="md:hidden text-right">
        <div className="display num text-[16px]">
          <AnimatedNumber value={display} format={(v) => formatUsd(v)} />
        </div>
        <PriceChange value={hasMeaningfulChange(view.status, price) ? price?.marketChange24hPct : null} className="text-[12px]" />
      </div>
      <div className="hidden md:flex justify-end">
        <Sparkline points={spark ?? []} width={84} height={26} />
      </div>
      <div className="hidden md:block text-right display num text-[16px]">
        <AnimatedNumber value={display} format={(v) => formatUsd(v)} />
        {price?.displaySource === "reference" && <span className="block text-[10px] font-mono text-ink-muted uppercase">reference</span>}
      </div>
      <div className="hidden md:block text-right">
        <PriceChange value={hasMeaningfulChange(view.status, price) ? price?.marketChange24hPct : null} />
      </div>
      <div className="hidden md:block text-right font-mono num text-[12px]">
        <span className="block">{price?.liquidityUsd ? formatUsdCompact(price.liquidityUsd) : "—"}</span>
        <span className="block text-ink-muted">{price?.volume24hUsd ? `${formatUsdCompact(price.volume24hUsd)} vol` : muted ? "no market" : "no volume"}</span>
      </div>
      <div className="hidden md:block text-right font-mono num text-[13px] text-ink-secondary">
        {formatUsd(price?.referenceUsd)}
        {price?.referenceFreshness === "stale" && <span className="block text-[10px] uppercase text-ink-muted">stale</span>}
        {price?.referenceFreshness === "last-close" && <span className="block text-[10px] uppercase text-ink-muted">last close</span>}
        {price?.referenceFreshness === "frozen" && <span className="block text-[10px] uppercase text-warning-fg">frozen</span>}
      </div>
      <div className="hidden md:flex items-center justify-end gap-1.5">
        {onToggleWatch && (
          <button type="button" aria-label={watched ? "Remove from watchlist" : "Add to watchlist"} aria-pressed={watched} onClick={onToggleWatch} className={cx("h-9 w-9 inline-flex items-center justify-center rounded-[6px] border transition-fast", watched ? "text-primary border-primary bg-primary-soft" : "text-ink-muted border-transparent hover:border-line hover:text-ink")}>
            <Star size={15} strokeWidth={1.75} fill={watched ? "currentColor" : "none"} />
          </button>
        )}
        {tradable && !restricted ? (
          <Link href={`/stocks/${asset.address}?trade=buy`} className="inline-flex items-center justify-center gap-1 h-9 min-w-[88px] px-3 rounded-[6px] text-[13px] font-medium bg-primary text-primary-contrast hover:bg-primary-strong transition-fast">
            Buy <ArrowUpRight size={14} strokeWidth={1.75} />
          </Link>
        ) : (
          <Link href={`/stocks/${asset.address}`} title={restricted && tradable ? "Trading is not available in your region" : undefined} className="inline-flex items-center justify-center h-9 min-w-[88px] px-3 rounded-[6px] text-[13px] font-medium border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
            {restricted && tradable ? "Unavailable" : view.status === "paused" ? "Paused" : view.status === "not-issued" ? "Watch" : "Details"}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Totals across the live markets: how much of the list trades, and how deep it is today. */
function MarketStats({ rows }: { rows: Array<{ asset: AssetsResponse["assets"][number]; price?: AssetsResponse["prices"][string] }> }) {
  const live = rows.filter((x) => {
    const st = tradingStatus(x.asset, x.price).status;
    return st === "tradable" || st === "thin";
  });
  const liquidity = live.reduce((sum, x) => sum + (x.price?.liquidityUsd ?? 0), 0);
  const volume = live.reduce((sum, x) => sum + (x.price?.volume24hUsd ?? 0), 0);
  const up = live.filter((x) => (x.price?.marketChange24hPct ?? 0) > 0).length;
  const cells = [
    { label: "Live markets", value: `${live.length} of ${rows.length}` },
    { label: "DEX liquidity", value: liquidity > 0 ? formatUsdCompact(liquidity) : "—" },
    { label: "24h volume", value: volume > 0 ? formatUsdCompact(volume) : "—" },
    { label: "Up today", value: live.length ? `${up} / ${live.length}` : "—" },
  ];
  return (
    <dl className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border border-line rounded-[8px] overflow-hidden">
      {cells.map((c) => (
        <div key={c.label} className="bg-canvas px-4 py-3">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{c.label}</dt>
          <dd className="display num text-[22px] leading-none mt-1">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

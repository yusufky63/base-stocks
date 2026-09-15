"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import type { CommunityBasket, CommunityPulse } from "@/domain/community";
import { apiGet } from "@/lib/client-api";
import { formatUsdCompact, bpsToPct, timeAgo } from "@/lib/format";
import { Module, ModuleHeader, PageTitle, Skeleton, LinkButton, Badge } from "@/components/ui/primitives";
import { useAssets } from "@/hooks/queries";
import { AssetLogo, ErrorBanner } from "@/components/common/display";

export function CommunityView({ embedded = false }: { embedded?: boolean } = {}) {
  const pulse = useQuery({ queryKey: ["community", "pulse"], queryFn: () => apiGet<CommunityPulse>("/api/community/pulse"), staleTime: 60_000 });
  const baskets = useQuery({ queryKey: ["baskets", "votes"], queryFn: async () => (await apiGet<{ baskets: CommunityBasket[] }>("/api/baskets?sort=votes&limit=30")).baskets, staleTime: 30_000 });
  const fresh = useQuery({ queryKey: ["baskets", "new"], queryFn: async () => (await apiGet<{ baskets: CommunityBasket[] }>("/api/baskets?sort=new&limit=10")).baskets, staleTime: 30_000 });
  const { data: assets } = useAssets();
  const byId = new Map((assets?.assets ?? []).map((a) => [a.canonicalId, a]));

  return (
    <div className="flex flex-col gap-6">
      {!embedded && (
      <PageTitle
        index="07 — Community"
        title="What BStocks users are doing"
        lead="Anonymous 7-day activity and baskets published by other users. Templates, not recommendations."
        action={
          <LinkButton href="/build" variant="primary">
            Publish a basket <ArrowRight size={16} strokeWidth={1.75} />
          </LinkButton>
        }
      />
      )}

      {/* A failed request is said so, with a way to try again; a skeleton that never resolves would read as "still loading". */}
      {pulse.isError && <ErrorBanner message="The 7-day pulse could not be loaded." onRetry={() => void pulse.refetch()} />}
      <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
        <PulseList title="Most bought · 7d" items={pulse.data?.mostBought ?? []} loading={pulse.isLoading} failed={pulse.isError} byId={byId} />
        <PulseList title="Most sold · 7d" items={pulse.data?.mostSold ?? []} loading={pulse.isLoading} failed={pulse.isError} byId={byId} />
        <div className="p-4 flex flex-col gap-2">
          <div className="eyebrow">Active traders · 7d</div>
          <div className="display num text-[44px] leading-none">{pulse.data?.traders ?? "—"}</div>
          <div className="text-[12px] text-ink-muted">wallets with a submitted trade{pulse.data ? ` · updated ${timeAgo(pulse.data.updatedAt)}` : ""}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <Module>
          <ModuleHeader index="A" title="Top baskets" action={<Link href="/build" className="text-[13px] text-primary font-medium">Build yours</Link>} />
          {baskets.isLoading && (
            <div className="p-4 flex flex-col gap-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          )}
          {baskets.isError && <ErrorBanner className="m-4" message="Community baskets could not be loaded." onRetry={() => void baskets.refetch()} />}
          {baskets.data?.map((b, i) => (
            <BasketRow key={b.id} basket={b} rank={i + 1} byId={byId} />
          ))}
          {baskets.data && baskets.data.length === 0 && <p className="px-4 py-5 text-[14px] text-ink-secondary">No community baskets yet. Build one and publish it from the Build page.</p>}
        </Module>
        <div className="flex flex-col gap-6">
          <Module>
            <ModuleHeader index="B" title="Newest baskets" />
            {fresh.isLoading && (
              <div className="p-4 flex flex-col gap-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            )}
            {fresh.isError && <ErrorBanner className="m-4" message="The newest baskets could not be loaded." onRetry={() => void fresh.refetch()} />}
            {fresh.data?.slice(0, 6).map((b) => (
              <BasketRow key={b.id} basket={b} byId={byId} compact />
            ))}
            {fresh.data && fresh.data.length === 0 && <p className="px-4 py-4 text-[13px] text-ink-secondary">Nothing yet.</p>}
          </Module>
        </div>
      </div>
    </div>
  );
}

function PulseList({ title, items, loading, failed, byId }: { title: string; items: CommunityPulse["mostBought"]; loading: boolean; failed: boolean; byId: Map<string, { logoURI?: string; symbol: string; address: string }> }) {
  return (
    <div className="p-4 flex flex-col gap-2">
      <div className="eyebrow">{title}</div>
      {loading && <Skeleton className="h-16" />}
      {failed && <p className="text-[13px] text-ink-muted">Unavailable right now.</p>}
      {!loading && !failed && items.length === 0 && <p className="text-[13px] text-ink-secondary">No trades in this window yet.</p>}
      <ul className="flex flex-col gap-1.5">
        {items.map((it, i) => {
          const a = byId.get(it.assetAddress.toLowerCase());
          return (
            <li key={it.assetAddress}>
              <Link href={`/stocks/${it.assetAddress}`} className="flex items-center justify-between gap-2 text-[14px] hover:text-primary">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-ink-muted w-4">{i + 1}</span>
                  {a && <AssetLogo src={a.logoURI} symbol={a.symbol} size={22} />}
                  <span className="font-medium">{it.symbol}</span>
                </span>
                <span className="font-mono num text-[12px] text-ink-secondary">
                  {it.trades} {it.trades === 1 ? "trade" : "trades"} · {formatUsdCompact(it.usd)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function BasketRow({ basket, rank, byId, compact = false }: { basket: CommunityBasket; rank?: number; byId: Map<string, { logoURI?: string; symbol: string; address: string; underlying?: string }>; compact?: boolean }) {
  return (
    <Link href={`/baskets/${basket.id}`} className="rail flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast">
      <span className="min-w-0 flex items-center gap-3">
        {rank && <span className="font-mono text-[12px] text-primary w-5">{String(rank).padStart(2, "0")}</span>}
        <span className="min-w-0">
          <span className="block font-medium text-[14px] truncate">{basket.name}</span>
          {!compact && <span className="block text-[12px] text-ink-secondary truncate">{basket.description || "No description"}</span>}
          <span className="block text-[11px] font-mono text-ink-muted truncate">{basket.allocations.map((a) => `${a.assetAddress === "USDC" ? "USDC" : (byId.get(a.assetAddress.toLowerCase())?.underlying ?? byId.get(a.assetAddress.toLowerCase())?.symbol ?? "?")} ${bpsToPct(a.weightBps)}`).join(" · ")}</span>
        </span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        <Badge tone="primary">▲ {basket.votes}</Badge>
        {!compact && <Badge>{basket.clones} clones</Badge>}
      </span>
    </Link>
  );
}

"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, Copy, Repeat } from "lucide-react";
import type { CommunityBasket, Profile } from "@/domain/community";
import { apiGet, apiPost, ApiError } from "@/lib/client-api";
import { useAuth } from "@/hooks/useAuth";
import { useAssets, useBasename } from "@/hooks/queries";
import { bpsToPct, formatUsd, shortenAddress } from "@/lib/format";
import { hasMeaningfulChange, tradingStatus } from "@/lib/trading-status";
import { automateHref } from "@/lib/automate-link";
import { Module, ModuleHeader, Button, Badge } from "@/components/ui/primitives";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { AllocationBar, ColorDot } from "@/components/common/AllocationBar";
import { ShareButton } from "@/components/common/ShareSheet";
import { PlanExecutor } from "@/components/build/PlanExecutor";
import { SignInButton } from "@/components/layout/SignInButton";

interface Detail {
  basket: CommunityBasket;
  voted: boolean;
  ownerProfile: Profile | null;
}

export function BasketDetailView({ id }: { id: string }) {
  const qc = useQueryClient();
  const auth = useAuth();
  const { data: assets } = useAssets();
  const { data, isLoading } = useQuery({ queryKey: ["basket", id], queryFn: () => apiGet<Detail>(`/api/baskets/${id}`), staleTime: 15_000 });
  const vote = useMutation({
    mutationFn: async () => {
      await auth.ensureSignedIn();
      return apiPost<{ voted: boolean; votes: number }>(`/api/baskets/${id}`, { action: "vote" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["basket", id] });
      qc.invalidateQueries({ queryKey: ["baskets"] });
    },
  });
  const clone = useMutation({ mutationFn: () => apiPost(`/api/baskets/${id}`, { action: "clone" }) });
  const ownerName = useBasename(data?.basket.owner);

  if (isLoading || !data) return <div className="border border-line rounded-[8px] p-8 text-ink-secondary">Loading basket…</div>;
  const b = data.basket;
  const ownerLabel = ownerName.data?.name ?? shortenAddress(b.owner);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/community" className="text-[13px] text-primary font-medium">
          ← Community
        </Link>
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mt-2">
          <div className="reveal">
            <div className="eyebrow mb-2">Community basket</div>
            <h1 className="display text-[36px] md:text-[52px] leading-[0.95]">{b.name}</h1>
            <p className="mt-2 max-w-[60ch] text-ink-secondary">{b.description || "No description."}</p>
            <p className="mt-2 text-[12px] font-mono text-ink-muted">
              by{" "}
              <Link href={`/u/${b.owner}`} className="text-primary">
                {ownerLabel}
              </Link>{" "}
              · {b.clones} clones · {b.votes} votes
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant={data.voted ? "primary" : "secondary"} size="sm" loading={vote.isPending} onClick={() => vote.mutate()}>
              <ThumbsUp size={14} strokeWidth={1.75} /> {data.voted ? "Voted" : "Upvote"} · {b.votes}
            </Button>
            <Link href={`/build?basket=${b.id}`} onClick={() => clone.mutate()} className="inline-flex items-center justify-center gap-2 h-9 min-h-[44px] px-3 rounded-[6px] border border-line-strong hover:border-line-strong hover:bg-surface text-[13px] font-medium transition-fast">
              <Copy size={14} strokeWidth={1.75} /> Clone & edit
            </Link>
            <Link href={automateHref(b.allocations, b.name)} className="inline-flex items-center justify-center gap-2 h-9 min-h-[44px] px-3 rounded-[6px] border border-line-strong hover:bg-surface text-[13px] font-medium transition-fast">
              <Repeat size={14} strokeWidth={1.75} /> Repeat on a schedule
            </Link>
            <ShareButton path={`/baskets/${b.id}`} text={`${b.name}: a tokenized-stock basket on BStocks (Base).`} title="Share basket" />
          </div>
        </div>
        {vote.error && <p className="mt-2 text-[13px] text-danger-fg">{vote.error instanceof ApiError ? vote.error.message : "Vote failed."}</p>}
        {!auth.isSignedIn && (
          <div className="mt-3">
            <SignInButton label="Sign in to vote" />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <Module ticks>
          <ModuleHeader title="Allocation" />
          <ul>
            {b.allocations.map((a) => {
              const asset = a.assetAddress === "USDC" ? null : assets?.assets.find((x) => x.canonicalId === a.assetAddress.toLowerCase());
              const price = asset ? assets?.prices[asset.canonicalId] : undefined;
              const status = asset ? tradingStatus(asset, price) : null;
              return (
                <li key={a.assetAddress} className="flex items-center justify-between px-4 py-3 border-b border-line last:border-b-0 gap-3">
                  <span className="flex items-center gap-3 min-w-0">
                    <ColorDot k={a.assetAddress} />
                    {asset ? <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={32} /> : <span className="inline-flex items-center justify-center h-8 w-8 rounded-[6px] border border-line font-mono text-[10px]">USDC</span>}
                    <span className="min-w-0">
                      <span className="block font-medium text-[14px]">
                        {asset ? asset.underlying : "USDC cash"}
                        {status && status.status !== "tradable" && <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-warning-fg">{status.label}</span>}
                      </span>
                      <span className="block text-[12px] text-ink-secondary truncate">{asset ? (status && status.status !== "tradable" ? status.detail : asset.name) : "Held as cash"}</span>
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block display num text-[16px]">{bpsToPct(a.weightBps)}</span>
                    {asset && (
                      <span className="block text-[12px] font-mono num text-ink-secondary">
                        {formatUsd(price?.displayUsd)} <PriceChange value={status && hasMeaningfulChange(status.status, price) ? price?.marketChange24hPct : null} />
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="px-4 py-3 border-t border-line">
            <AllocationBar segments={b.allocations.map((a) => ({ key: a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : (assets?.assets.find((x) => x.canonicalId === a.assetAddress.toLowerCase())?.underlying ?? "?"), weightBps: a.weightBps }))} height={10} />
          </div>
        </Module>
        <Module className="lg:sticky lg:top-[72px]">
          <ModuleHeader title="Invest in this basket" action={<Badge>community</Badge>} />
          <div className="p-4">
            <PlanExecutor key={b.id} allocations={b.allocations} source="community" />
          </div>
          <p className="px-4 pb-4 text-[12px] text-ink-muted">Published by another user. A template, not a recommendation. Every leg is confirmed by you.</p>
        </Module>
      </div>
    </div>
  );
}

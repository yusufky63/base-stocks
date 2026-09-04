"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Gift, Lock, Users } from "lucide-react";
import type { PoolView } from "@/domain/pool";
import { apiGet } from "@/lib/client-api";
import { isPoolDeployed } from "@/lib/pool";
import { formatTokenAmount, formatUsd, shortenAddress } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { TimeAgo } from "@/components/common/TimeAgo";
import { Badge, LinkButton, Module, ModuleHeader, Skeleton, cx } from "@/components/ui/primitives";

/** "0.1 NVDA + 0.05 AAPL" — what one person takes out of this pool. */
export function shareLabel(v: PoolView): string {
  if (v.legs.length === 0) return "a stock";
  return v.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ");
}

export function remainingShares(v: PoolView): number {
  return v.onchain?.remainingSlots ?? Math.max(0, v.pool.slots - v.claimCount);
}

/** One shared query so the directory, the Gifts tab and the home card never disagree. */
export function usePublicPools() {
  return useQuery({
    queryKey: ["pools", "public"],
    queryFn: () => apiGet<{ pools: PoolView[] }>("/api/pools").then((r) => r.pools),
    enabled: isPoolDeployed(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/* -------------------------------- the card -------------------------------- */

export function PoolCard({ view }: { view: PoolView }) {
  const [loadedAt] = useState(() => Date.now());
  const remaining = remainingShares(view);
  const taken = view.pool.slots - remaining;
  const pct = view.pool.slots > 0 ? Math.round((taken / view.pool.slots) * 100) : 0;
  const locked = view.pool.lockedUntil > loadedAt;

  return (
    <Link href={`/pools/${view.pool.id}`} className="block group">
      <Module className="h-full transition-fast group-hover:border-line-strong">
        <div className="p-4 flex flex-col gap-3 h-full">
          <div className="flex items-start gap-3">
            <span className="flex items-center -space-x-2 shrink-0">
              {view.legs.slice(0, 3).map((l) => (
                <span key={l.token} className="rounded-full ring-2 ring-canvas">
                  <AssetLogo src={l.logoURI} symbol={l.underlying} size={34} />
                </span>
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium text-[15px] truncate">{view.pool.title || shareLabel(view)}</span>
                {view.pool.verified && <BadgeCheck size={15} strokeWidth={2} className="text-primary shrink-0" aria-label="Verified by BStocks" />}
              </span>
              <span className="block text-[12px] text-ink-secondary truncate">by {view.creatorBasename ?? shortenAddress(view.pool.creator)}</span>
            </span>
          </div>

          <div className="flex items-baseline justify-between gap-2">
            <span className="display num text-[20px]">{shareLabel(view)}</span>
            {view.usdPerClaim !== null && <span className="font-mono num text-[13px] text-ink-secondary">{formatUsd(view.usdPerClaim)}</span>}
          </div>

          <div className="mt-auto flex flex-col gap-2">
            <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
              <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between gap-2 text-[12px]">
              <span className="text-ink-secondary inline-flex items-center gap-1.5">
                <Users size={13} strokeWidth={1.75} /> {`${remaining} of ${view.pool.slots} left`}
              </span>
              <span className="flex items-center gap-1.5">
                {locked && (
                  <Badge>
                    <span className="inline-flex items-center gap-1">
                      <Lock size={11} strokeWidth={2} /> Locked
                    </span>
                  </Badge>
                )}
                {view.pool.quests.length > 0 && <Badge tone="primary">{`${view.pool.quests.length} step${view.pool.quests.length > 1 ? "s" : ""}`}</Badge>}
              </span>
            </div>
          </div>
        </div>
      </Module>
    </Link>
  );
}

/* -------------------------------- the list -------------------------------- */

/**
 * Open public pools, and the ones that have finished. Mounted twice — as the `/pools` page and as
 * a tab on `/gifts` — off one query, so the two can never drift apart.
 */
export function PoolList({ columns = 2, showFinished = true }: { columns?: 2 | 3; showFinished?: boolean }) {
  const pools = usePublicPools();
  const all = pools.data ?? [];
  const open = all.filter((v) => v.pool.status === "live" && remainingShares(v) > 0);
  const finished = all.filter((v) => !(v.pool.status === "live" && remainingShares(v) > 0));

  if (pools.isLoading) {
    return (
      <div className={cx("grid gap-4", columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2")}>
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {open.length === 0 ? (
        <Module>
          <div className="p-6 flex flex-col items-start gap-3">
            <p className="text-[14px] text-ink-secondary">
              No public pools are open right now. Pools shared by link never appear here — only the ones their creator chose to list.
            </p>
            <LinkButton href="/gifts" variant="primary">
              Create the first one
            </LinkButton>
          </div>
        </Module>
      ) : (
        <div className={cx("grid gap-4", columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2")}>
          {open.map((v) => (
            <PoolCard key={v.pool.id} view={v} />
          ))}
        </div>
      )}

      {showFinished && finished.length > 0 && (
        <Module>
          <div className="px-4 py-3 border-b border-line font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Finished</div>
          <ul>
            {finished.slice(0, 12).map((v) => {
              const taken = v.pool.slots - remainingShares(v);
              return (
                <li key={v.pool.id}>
                  <Link href={`/pools/${v.pool.id}`} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-surface transition-fast min-w-0">
                    <span className="flex items-center -space-x-2 shrink-0">
                      {v.legs.slice(0, 3).map((l) => (
                        <span key={l.token} className="rounded-full ring-2 ring-canvas">
                          <AssetLogo src={l.logoURI} symbol={l.underlying} size={24} />
                        </span>
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium truncate">{v.pool.title || shareLabel(v)}</span>
                      <span className="block text-[11px] text-ink-muted">
                        {`${taken} of ${v.pool.slots} claimed · `}
                        <TimeAgo value={v.pool.createdAt} />
                      </span>
                    </span>
                    <Badge>{v.pool.status === "cancelled" ? "Closed" : remainingShares(v) === 0 ? "All claimed" : "Ended"}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Module>
      )}
    </div>
  );
}

/* -------------------------------- home card ------------------------------- */

/**
 * The gifts card on the home page. Always present, because the point is that gifting exists at
 * all — but what it says depends on whether anything is actually claimable.
 *
 * With open pools it is a shelf: what each one pays, how many shares are left, one tap in. With
 * none it is the invitation instead. What it never is, is an empty "nothing to claim" box, which
 * would be the worst of both.
 */
export function GiftsCard({ max = 2 }: { max?: number }) {
  const pools = usePublicPools();
  const open = (pools.data ?? []).filter((v) => v.pool.status === "live" && remainingShares(v) > 0).slice(0, max);

  if (open.length === 0) {
    return (
      <Module>
        <ModuleHeader
          title="Gift stock"
          action={
            <Link href="/pools" className="text-[13px] text-primary font-medium">
              Open pools
            </Link>
          }
        />
        <div className="p-4 flex flex-col sm:flex-row sm:items-center gap-4">
          <span className="h-11 w-11 rounded-full bg-primary-soft inline-flex items-center justify-center shrink-0" aria-hidden>
            <Gift size={20} strokeWidth={1.75} className="text-primary" />
          </span>
          <p className="text-[13px] text-ink-secondary flex-1 min-w-0">
            Send a share of a stock to a Basename, an address, or a link that needs no wallet at all. Or fund a pool and let a whole group take one share each.
          </p>
          <LinkButton href="/gifts" variant="primary" className="shrink-0">
            Gift a stock
          </LinkButton>
        </div>
      </Module>
    );
  }

  return (
    <Module>
      <ModuleHeader
        title="Free stock to claim"
        action={
          <Link href="/pools" className="text-[13px] text-primary font-medium">
            All pools
          </Link>
        }
      />
      <ul>
        {open.map((v) => (
          <li key={v.pool.id}>
            <Link href={`/pools/${v.pool.id}`} className="rail flex items-center gap-3 px-4 py-3 border-b border-line last:border-b-0 hover:bg-surface transition-fast min-w-0">
              <span className="flex items-center -space-x-2 shrink-0">
                {v.legs.slice(0, 3).map((l) => (
                  <span key={l.token} className="rounded-full ring-2 ring-canvas">
                    <AssetLogo src={l.logoURI} symbol={l.underlying} size={28} />
                  </span>
                ))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-[14px] leading-tight truncate">{shareLabel(v)}</span>
                <span className="block text-[12px] text-ink-secondary truncate">{v.pool.title || `by ${v.creatorBasename ?? shortenAddress(v.pool.creator)}`}</span>
              </span>
              <span className="text-right shrink-0">
                {v.usdPerClaim !== null && <span className="block display num text-[15px]">{formatUsd(v.usdPerClaim)}</span>}
                <span className="block text-[11px] text-ink-muted num">{`${remainingShares(v)} left`}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="px-4 py-2.5 text-[11px] text-ink-muted border-t border-line flex items-center gap-1.5">
        <Gift size={12} strokeWidth={1.75} /> One share per wallet. No wallet? A passkey one takes seconds and the claim fee is covered.
      </p>
    </Module>
  );
}

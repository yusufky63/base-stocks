"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Lock, Users } from "lucide-react";
import type { PoolView } from "@/domain/pool";
import { apiGet } from "@/lib/client-api";
import { formatTokenAmount, formatUsd, shortenAddress } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { Badge, LinkButton, Module, PageTitle, Skeleton } from "@/components/ui/primitives";
import { TimeAgo } from "@/components/common/TimeAgo";

function shareLabel(v: PoolView): string {
  if (v.legs.length === 0) return "a stock";
  return v.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ");
}

/**
 * The public pool directory. Only pools their creator chose to list appear here, and only a
 * verified one carries the check — anyone can name a pool "Official Coinbase giveaway", so the
 * badge, not the title, is what says a human looked at it.
 */
export function PoolsDirectory() {
  const pools = useQuery({
    queryKey: ["pools", "public"],
    queryFn: () => apiGet<{ pools: PoolView[] }>("/api/pools").then((r) => r.pools),
    refetchInterval: 60_000,
  });

  const list = (pools.data ?? []).filter((v) => v.pool.status === "live");
  const closed = (pools.data ?? []).filter((v) => v.pool.status !== "live");

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="Pools"
        title="Open gift pools"
        lead="One deposit, many equal shares. Open a pool, take your one share, and the stock is yours — self-custodial, on Base."
        action={
          <LinkButton href="/gifts" variant="primary">
            Create a pool
          </LinkButton>
        }
      />

      {pools.isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : list.length === 0 ? (
        <Module>
          <div className="p-6 flex flex-col items-start gap-3">
            <p className="text-[14px] text-ink-secondary">No public pools are open right now. Pools shared by link do not appear here — only the ones their creator chose to list.</p>
            <LinkButton href="/gifts" variant="primary">
              Create the first one
            </LinkButton>
          </div>
        </Module>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {list.map((v) => (
            <PoolCard key={v.pool.id} view={v} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <Module>
          <div className="px-4 py-3 border-b border-line font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Finished</div>
          <ul>
            {closed.slice(0, 10).map((v) => (
              <li key={v.pool.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-b-0">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium truncate">{v.pool.title || shareLabel(v)}</span>
                  <span className="block text-[11px] text-ink-muted">
                    {`${v.claimCount} of ${v.pool.slots} claimed · `}
                    <TimeAgo value={v.pool.createdAt} />
                  </span>
                </span>
                <Badge>{v.pool.status === "cancelled" ? "Closed" : "Ended"}</Badge>
              </li>
            ))}
          </ul>
        </Module>
      )}

      <p className="text-[12px] text-ink-muted">
        Pools are held by an ownerless contract: it can only pay a claimant their exact share or return the remainder to the creator. A creator without a lock badge can close their pool at any time.
      </p>
    </div>
  );
}

function PoolCard({ view }: { view: PoolView }) {
  const [loadedAt] = useState(() => Date.now());
  const remaining = view.onchain?.remainingSlots ?? Math.max(0, view.pool.slots - view.claimCount);
  const pct = view.pool.slots > 0 ? Math.round(((view.pool.slots - remaining) / view.pool.slots) * 100) : 0;
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
              <span className="block text-[12px] text-ink-secondary truncate">
                by {view.creatorBasename ?? shortenAddress(view.pool.creator)}
              </span>
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
                {view.pool.quests.length > 0 && <Badge tone="primary">{`${view.pool.quests.length} task${view.pool.quests.length > 1 ? "s" : ""}`}</Badge>}
              </span>
            </div>
          </div>
        </div>
      </Module>
    </Link>
  );
}

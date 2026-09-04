"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { Lock, Users } from "lucide-react";
import type { PoolView } from "@/domain/pool";
import { apiGet } from "@/lib/client-api";
import { formatTokenAmount } from "@/lib/format";
import { AssetLogo } from "@/components/common/display";
import { TimeAgo } from "@/components/common/TimeAgo";
import { Badge, Module, ModuleHeader, Skeleton } from "@/components/ui/primitives";

function statusInfo(v: PoolView): { label: string; tone: "positive" | "warning" | "danger" | "neutral" | "primary" } {
  switch (v.pool.status) {
    case "cancelled":
      return { label: "Closed", tone: "neutral" };
    case "expired":
      return { label: "Ended", tone: "neutral" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "live":
      return (v.onchain?.remainingSlots ?? 0) === 0 ? { label: "All claimed", tone: "positive" } : { label: "Open", tone: "primary" };
    default:
      return { label: "Settling", tone: "warning" };
  }
}

/** Pools this wallet created, with the live share counter and a way into the manage panel. */
export function PoolHistory({ owner }: { owner: Address }) {
  // Snapshot the clock once: a lock badge that flips mid-render would make the list jump.
  const [loadedAt] = useState(() => Date.now());
  const pools = useQuery({
    queryKey: ["pools", "mine", owner.toLowerCase()],
    queryFn: () => apiGet<{ pools: PoolView[] }>(`/api/pools?creator=${owner}`).then((r) => r.pools),
    refetchInterval: 30_000,
  });

  const list = pools.data ?? [];
  if (!pools.isLoading && list.length === 0) return null;

  return (
    <Module>
      <ModuleHeader title="Your pools" />
      {pools.isLoading ? (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-14" />
        </div>
      ) : (
        <ul>
          {list.map((v) => {
            const s = statusInfo(v);
            const remaining = v.onchain?.remainingSlots ?? Math.max(0, v.pool.slots - v.claimCount);
            const claimed = v.pool.slots - remaining;
            return (
              <li key={v.pool.id} className="border-b border-line last:border-b-0">
                <Link href={`/pools/${v.pool.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface transition-fast min-w-0">
                  <span className="flex items-center -space-x-2 shrink-0">
                    {v.legs.slice(0, 3).map((l) => (
                      <span key={l.token} className="rounded-full ring-2 ring-canvas">
                        <AssetLogo src={l.logoURI} symbol={l.underlying} size={30} />
                      </span>
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-[14px] truncate">
                        {v.pool.title || v.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ")}
                      </span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                      {v.pool.lockedUntil > loadedAt && (
                        <Badge>
                          <span className="inline-flex items-center gap-1">
                            <Lock size={11} strokeWidth={2} /> Locked
                          </span>
                        </Badge>
                      )}
                    </span>
                    <span className="block text-[12px] text-ink-secondary truncate">
                      <Users size={11} strokeWidth={1.75} className="inline mr-1 -mt-0.5" />
                      {`${claimed} of ${v.pool.slots} claimed`}
                      {v.pool.visibility === "public" ? " · public" : " · by link"}
                      {" · "}
                      <TimeAgo value={v.pool.createdAt} />
                    </span>
                  </span>
                  <span className="text-[12px] font-medium text-primary shrink-0">Manage →</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Module>
  );
}

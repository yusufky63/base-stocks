"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { apiGet } from "@/lib/client-api";
import type { MarketDigest } from "@/domain/digest";
import { useAssets } from "@/hooks/queries";
import { timeAgo } from "@/lib/format";
import { Badge, Module, ModuleHeader, Skeleton } from "@/components/ui/primitives";

const MOOD: Record<MarketDigest["mood"], { label: string; tone: "neutral" | "warning" | "danger" }> = { calm: { label: "calm", tone: "neutral" }, mixed: { label: "mixed", tone: "warning" }, volatile: { label: "volatile", tone: "danger" } };

/**
 * "Today's brief": one shared AI summary of the headlines and prices on this page, refreshed every
 * six hours for everyone (so the cost is fixed, not per visitor). Facts only, no advice.
 */
export function MarketDigestCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ["news", "digest"], queryFn: () => apiGet<{ enabled: boolean; digest: MarketDigest | null }>("/api/news/digest"), staleTime: 5 * 60_000 });
  const { data: assets } = useAssets();
  if (data && !data.enabled) return null;
  const d = data?.digest ?? null;
  const addressOf = (ticker: string) => assets?.assets.find((a) => a.underlying.toUpperCase() === ticker)?.address;
  return (
    <Module>
      <ModuleHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles size={14} strokeWidth={1.75} className="text-primary" /> Today&apos;s brief
          </span>
        }
        action={d ? <span className="font-mono text-[11px] text-ink-muted inline-flex items-center gap-2">{!compact && <Badge tone={MOOD[d.mood].tone}>{MOOD[d.mood].label}</Badge>}updated {timeAgo(d.generatedAt)}</span> : undefined}
      />
      <div className="p-4 flex flex-col gap-3">
        {isLoading && !data && <Skeleton className="h-16" />}
        {data && !d && <p className="text-[13px] text-ink-secondary">The brief is being prepared; check back in a few minutes.</p>}
        {d && (
          <>
            <p className="text-[15px] font-medium leading-snug">{d.headline}</p>
            <p className="text-[14px] text-ink-secondary leading-relaxed">{d.summary}</p>
            {!compact && d.bullets.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {d.bullets.map((b, i) => {
                  const addr = addressOf(b.ticker);
                  return (
                    <li key={`${b.ticker}-${i}`} className="text-[13px] flex gap-2">
                      {addr ? (
                        <Link href={`/stocks/${addr}`} className="font-mono text-[12px] text-primary font-medium shrink-0 w-[52px]">
                          {b.ticker}
                        </Link>
                      ) : (
                        <span className="font-mono text-[12px] text-ink-muted shrink-0 w-[52px]">{b.ticker}</span>
                      )}
                      <span className="text-ink-secondary">{b.note}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[11px] text-ink-muted">Written by an AI model from {d.headlines} headlines and the prices shown here, US market {d.marketOpen ? "open" : "closed"} at the time. Facts may lag; not advice.</p>
          </>
        )}
      </div>
    </Module>
  );
}

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

/** A ticker as a link to its stock page when it is listed here, plain text otherwise. */
function Ticker({ t, addr }: { t: string; addr?: string }) {
  return addr ? (
    <Link href={`/stocks/${addr}`} className="font-mono text-[12px] text-primary font-medium">
      {t}
    </Link>
  ) : (
    <span className="font-mono text-[12px] text-ink-muted">{t}</span>
  );
}

/**
 * "Today's brief": one shared AI summary of the headlines and prices on this page, refreshed every
 * six hours for everyone (so the cost is fixed, not per visitor). It leads with Base & Coinbase —
 * the tokenized-stock listings, venues and standard this app is built on — then the stocks, then
 * the wider market. Facts only, no advice.
 */
export function MarketDigestCard({ compact = false }: { compact?: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ["news", "digest"], queryFn: () => apiGet<{ enabled: boolean; digest: MarketDigest | null }>("/api/news/digest"), staleTime: 5 * 60_000 });
  const { data: assets } = useAssets();
  if (data && !data.enabled) return null;
  const d = data?.digest ?? null;
  const addressOf = (ticker: string) => assets?.assets.find((a) => a.underlying.toUpperCase() === ticker)?.address;
  const spotlight = d?.spotlight ?? [];
  const themes = d?.themes ?? [];
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
            {spotlight.length > 0 && (
              <div className="border border-primary/40 bg-primary-soft/40 rounded-[8px] p-3 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-primary">Base &amp; Coinbase</span>
                  <Link href="/news?scope=ecosystem" className="text-[12px] text-primary font-medium">
                    All ecosystem headlines →
                  </Link>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {spotlight.slice(0, compact ? 3 : 5).map((s, i) => (
                    <li key={`${i}-${s.note.slice(0, 24)}`} className="text-[13px] flex flex-col gap-0.5">
                      <span className="text-ink">{s.note}</span>
                      {s.tickers.length > 0 && (
                        <span className="flex gap-2 flex-wrap">
                          {s.tickers.map((t) => (
                            <Ticker key={t} t={t} addr={addressOf(t)} />
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!compact && d.bullets.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {d.bullets.map((b, i) => (
                  <li key={`${b.ticker}-${i}`} className="text-[13px] flex gap-2">
                    <span className="shrink-0 w-[52px]">
                      <Ticker t={b.ticker} addr={addressOf(b.ticker)} />
                    </span>
                    <span className="text-ink-secondary">{b.note}</span>
                  </li>
                ))}
              </ul>
            )}
            {!compact && themes.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mr-1">Themes</span>
                {themes.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
            )}
            <p className="text-[11px] text-ink-muted">
              Written by an AI model from {d.headlines} headlines{d.sources ? ` across ${d.sources} feeds` : ""} and the prices shown here, US market {d.marketOpen ? "open" : "closed"} at the time. Facts may lag; not advice.
            </p>
          </>
        )}
      </div>
    </Module>
  );
}

"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { apiGet } from "@/lib/client-api";
import { timeAgo } from "@/lib/format";
import { Module, ModuleHeader, Skeleton, cx } from "@/components/ui/primitives";
import type { NewsVia } from "@/content/news-sources";

export interface NewsItemDTO {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  ticker: string;
  via: NewsVia;
  /** Listed tickers the title names (ecosystem feed). */
  tickers?: string[];
  /** About tokenized stocks on Base or Coinbase's listings. */
  spotlight?: boolean;
}

export type NewsFeedFilter = "stocks" | "markets" | "ecosystem" | "x" | { ticker: string };

export function newsQueryKey(filter: NewsFeedFilter, limit: number) {
  return ["news", typeof filter === "string" ? filter : `t:${filter.ticker}`, limit] as const;
}

export function useNewsFeed(filter: NewsFeedFilter, limit = 8) {
  const qs = typeof filter === "string" ? (filter === "stocks" ? "" : `scope=${filter}&`) : `ticker=${encodeURIComponent(filter.ticker)}&`;
  return useQuery({
    queryKey: newsQueryKey(filter, limit),
    queryFn: () => apiGet<{ items: NewsItemDTO[]; updatedAt: number }>(`/api/news?${qs}limit=${limit}`),
    staleTime: 5 * 60_000,
  });
}

/** Backwards-compatible helper: mixed stock feed, or one ticker. */
export function useNews(ticker?: string, limit = 8) {
  return useNewsFeed(ticker ? { ticker } : "stocks", limit);
}

/** Short headlines only: source · time · title → publisher link. Never article text. */
export function NewsList({ items, showTicker = false, compact = false }: { items: NewsItemDTO[]; showTicker?: boolean; compact?: boolean }) {
  if (items.length === 0) return <p className="px-4 py-4 text-[13px] text-ink-secondary">No recent headlines.</p>;
  return (
    <ul>
      {items.map((n, i) => (
        <li key={`${n.id}-${n.ticker}-${i}`} className="border-b border-line last:border-b-0">
          <a href={n.url} target="_blank" rel="noreferrer noopener" className={cx("rail flex items-start gap-3 px-4 hover:bg-surface transition-fast", compact ? "py-2.5" : "py-3")}>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted mb-0.5">
                {showTicker && n.ticker !== "MARKETS" && n.ticker !== "BASE" && n.ticker !== "X" && <span className="text-primary">{n.ticker}</span>}
                {(n.ticker === "BASE" || n.ticker === "X") && n.tickers && n.tickers.length > 0 && <span className="text-primary">{n.tickers.join(" · ")}</span>}
                {n.spotlight && n.ticker !== "BASE" && n.ticker !== "X" && <span className="text-primary border border-primary/40 rounded-[3px] px-1 leading-4">Base</span>}
                <span className="truncate">{n.source}</span>
                <span>·</span>
                <span>{n.publishedAt ? timeAgo(n.publishedAt) : ""}</span>
              </span>
              <span className={cx("block text-ink leading-snug line-clamp-2", compact ? "text-[13px]" : "text-[14px]")}>{n.title}</span>
            </span>
            <ExternalLink size={14} strokeWidth={1.75} className="shrink-0 mt-1 text-ink-muted" />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function NewsModule({ ticker, title = "News", index, limit = 6, showTicker = false, compact = false, className, href = "/news" }: { ticker?: string; title?: string; index?: string; limit?: number; showTicker?: boolean; compact?: boolean; className?: string; href?: string }) {
  const { data, isLoading } = useNews(ticker, limit);
  return (
    <Module className={className}>
      <ModuleHeader
        index={index}
        title={title}
        action={
          <span className="flex items-center gap-3">
            {data && <span className="font-mono text-[11px] text-ink-muted">{timeAgo(data.updatedAt)}</span>}
            <Link href={href} className="text-[13px] text-primary font-medium">
              All news →
            </Link>
          </span>
        }
      />
      {isLoading && !data ? (
        <div className="p-4 flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <NewsList items={data?.items ?? []} showTicker={showTicker} compact={compact} />
      )}
      <p className="px-4 py-2 text-[11px] text-ink-muted border-t border-line">Headlines from multiple publishers; links open at the source. Not investment advice.</p>
    </Module>
  );
}

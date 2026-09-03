"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useAssets } from "@/hooks/queries";
import { useTickerSettings } from "@/hooks/useSettings";
import { NEWS_SOURCES } from "@/content/news-sources";
import { timeAgo } from "@/lib/format";
import { Module, ModuleHeader, Chip, Skeleton, PageTitle, cx } from "@/components/ui/primitives";
import { NewsList, useNewsFeed, type NewsFeedFilter } from "./NewsModule";
import { MarketDigestCard } from "./MarketDigestCard";

/**
 * News page: one place for all headlines. Filter by "All stocks", "Markets" or a single ticker.
 * Sources are listed openly; nothing is summarised or rewritten — titles link to the publisher.
 */
export function NewsView() {
  const { data: assets } = useAssets();
  const [filter, setFilter] = useState<NewsFeedFilter>("stocks");
  const feed = useNewsFeed(filter, typeof filter === "string" ? 30 : 20);
  const ticker = useTickerSettings();
  const tickers = (assets?.assets ?? []).map((a) => a.underlying);
  const activeTicker = typeof filter === "string" ? null : filter.ticker;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="07 — News" title="Headlines" lead="Headlines for the tokenized stocks and the wider market, opened at the source." />

      <MarketDigestCard />

      <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap">
        <Chip active={filter === "stocks"} onClick={() => setFilter("stocks")}>
          All stocks
        </Chip>
        <Chip active={filter === "markets"} onClick={() => setFilter("markets")}>
          Markets
        </Chip>
        <span aria-hidden className="w-px bg-line shrink-0 my-1" />
        {tickers.map((t) => (
          <Chip key={t} active={activeTicker === t} onClick={() => setFilter({ ticker: t })}>
            {t}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-6 items-start">
        <Module ticks>
          <ModuleHeader title={filter === "stocks" ? "Latest across stocks" : filter === "markets" ? "Markets" : `${activeTicker} headlines`} action={feed.data ? <span className="font-mono text-[11px] text-ink-muted">updated {timeAgo(feed.data.updatedAt)}</span> : undefined} />
          {feed.isLoading && !feed.data ? (
            <div className="p-4 flex flex-col gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : feed.isError ? (
            <p className="px-4 py-4 text-[13px] text-danger-fg">Headlines could not be loaded right now.</p>
          ) : (
            <NewsList items={feed.data?.items ?? []} showTicker={filter !== "markets" && activeTicker === null} />
          )}
        </Module>

        <div className="flex flex-col gap-6">
          <Module>
            <ModuleHeader title="In the ticker" />
            <div className="p-4 flex flex-col gap-3">
              <p className="text-[13px] text-ink-secondary">Show a scrolling headline row above the header. Off by default; prices stay on.</p>
              <div className="flex gap-2">
                <Chip active={ticker.news} onClick={() => ticker.set({ news: true })}>
                  On
                </Chip>
                <Chip active={!ticker.news} onClick={() => ticker.set({ news: false })}>
                  Off
                </Chip>
              </div>
            </div>
          </Module>

          <Module>
            <ModuleHeader title="Sources" />
            <ul>
              {NEWS_SOURCES.map((s) => (
                <li key={s.id} className="px-4 py-2.5 border-b border-line last:border-b-0">
                  <a href={s.homepage} target="_blank" rel="noreferrer noopener" className="flex items-center justify-between gap-2 text-[13px] font-medium hover:text-primary transition-fast">
                    {s.label}
                    <span className={cx("font-mono text-[10px] uppercase tracking-[0.08em]", s.scope === "ticker" ? "text-primary" : "text-ink-muted")}>{s.scope === "ticker" ? "per stock" : "markets"}</span>
                  </a>
                  <p className="text-[12px] text-ink-muted">{s.note}</p>
                </li>
              ))}
            </ul>
            <p className="px-4 py-2 text-[11px] text-ink-muted border-t border-line inline-flex items-center gap-1">
              Keyless RSS, cached 15 min server-side <ExternalLink size={11} strokeWidth={1.75} />
            </p>
          </Module>
        </div>
      </div>
    </div>
  );
}

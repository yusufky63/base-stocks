"use client";

import Link from "next/link";
import { useStats } from "@/hooks/queries";
import { LEDGER_LABEL, ledgerTone } from "@/lib/stats/labels";
import { formatUsd, timeAgo } from "@/lib/format";
import { Module, ModuleHeader, Skeleton, cx } from "@/components/ui/primitives";
import { TxLink } from "@/components/common/display";

/**
 * The public activity feed: the latest transactions the app has matched to their receipts on
 * Base, with no wallet named. It is a view of the platform statistics response — the same
 * five-minute, shared-cache object the home page's counters and `/stats` read — so a thousand
 * visitors cost one computation, and a line here is exactly a line on the stats page.
 *
 * Anonymous by construction: the ledger carries kind, stock, amount and the transaction hash,
 * never an address. The hash is public on Base and is the proof.
 */
export function PublicFeed({ limit = 6, title = "Live on Base", compact }: { limit?: number; title?: string; compact?: boolean }) {
  const { data, isLoading } = useStats();
  const entries = (data?.ledger ?? []).slice(0, limit);
  return (
    <Module ticks={!compact}>
      <ModuleHeader
        title={title}
        action={
          <Link href="/stats" className="text-[13px] text-primary font-medium">
            All verified →
          </Link>
        }
      />
      {isLoading && !data ? (
        <div className="p-4 flex flex-col gap-2">
          {Array.from({ length: Math.min(limit, 4) }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-ink-secondary">Nothing verified yet. The first transaction through the app shows up here once its receipt is in.</p>
      ) : (
        <ol className="divide-y divide-line">
          {entries.map((e, i) => {
            const tone = ledgerTone(e.kind);
            return (
              <li key={`${e.txHash}:${e.kind}:${i}`} className="px-4 py-2.5 flex items-center gap-3 text-[13px]">
                <span className={cx("h-1.5 w-1.5 rounded-full shrink-0", tone === "positive" ? "bg-positive-fg" : tone === "negative" ? "bg-danger-fg" : "bg-ink-muted")} aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  <span className={cx("font-medium", tone === "positive" ? "text-positive-fg" : tone === "negative" ? "text-danger-fg" : "text-ink")}>{LEDGER_LABEL[e.kind]}</span>
                  {e.count && e.count > 1 ? <span className="text-ink-muted"> × {e.count}</span> : null}
                  {e.symbol ? <span className="text-ink-secondary"> · {e.symbol.replace(/c$/, "")}</span> : null}
                </span>
                <span className="font-mono num text-[12px] text-ink-secondary shrink-0">{e.usd !== undefined ? formatUsd(e.usd) : "—"}</span>
                <span className="font-mono text-[11px] text-ink-muted shrink-0 w-[64px] text-right" title={new Date(e.at).toISOString()}>
                  {timeAgo(e.at)}
                </span>
                <span className="hidden sm:inline font-mono text-[11px] shrink-0">
                  <TxLink hash={e.txHash}>{e.txHash.slice(0, 8)}…</TxLink>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted">Anonymous: each line is one receipt on Base, matched by the app, with no wallet named{data ? ` · updated ${timeAgo(data.generatedAt)}` : ""}.</p>
    </Module>
  );
}

"use client";

import Link from "next/link";
import type { Address } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import { useActivity } from "@/hooks/queries";
import { formatTokenAmount, formatUsd, timeAgo } from "@/lib/format";
import { Skeleton, cx } from "@/components/ui/primitives";
import { TxLink } from "@/components/common/display";
import { counterpartyLabel } from "@/components/activity/ActivityList";

const LABEL: Record<string, string> = { buy: "Bought", sell: "Sold", send: "Sent", receive: "Received", "portfolio-build": "Basket buy" };

/** Below "Your position": this wallet's own trades, sends and receipts of the stock, from the activity timeline. */
export function TradesModule({ asset, user }: { asset: B20AssetDTO; user?: Address }) {
  const activity = useActivity(user);
  if (!user) return null;
  const mine = (activity.data ?? []).filter((it) => it.assetAddress?.toLowerCase() === asset.canonicalId).slice(0, 8);
  return (
    <section className="border-t border-line">
      <header className="flex items-center justify-between px-4 md:px-5 py-2.5">
        <span className="eyebrow">Your trades</span>
        {mine.length > 0 && (
          <Link href="/portfolio" className="text-[12px] text-primary font-medium">
            All activity →
          </Link>
        )}
      </header>
      {activity.isLoading && <Skeleton className="h-10 mx-4 mb-3" />}
      {activity.isError && <p className="px-4 md:px-5 pb-3 text-[13px] text-ink-secondary">Activity could not be loaded.</p>}
      {!activity.isLoading && !activity.isError && mine.length === 0 && <p className="px-4 md:px-5 pb-3 text-[13px] text-ink-secondary">No {asset.underlying} trades from this wallet yet.</p>}
      {mine.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {mine.map((it) => (
            <li key={it.id} className="px-4 md:px-5 py-2 grid grid-cols-[1fr_auto] gap-3 text-[13px] items-center">
              <span className="min-w-0">
                <span className={cx("font-medium", it.type === "buy" || it.type === "receive" ? "text-positive-fg" : it.type === "sell" || it.type === "send" ? "text-danger-fg" : "")}>{LABEL[it.type] ?? it.type}</span>
                {it.counterparty && (it.type === "send" || it.type === "receive") ? <span className="text-ink-secondary"> {it.type === "send" ? "to" : "from"} {counterpartyLabel(it)}</span> : null}
                <span className="block font-mono text-[11px] text-ink-muted">
                  {it.timestamp ? timeAgo(it.timestamp) : it.blockNumber ? `block ${it.blockNumber}` : "pending"}
                  {it.provider ? ` · ${it.provider}` : ""}
                  {!it.verified && it.source === "app" ? " · pending verification" : ""}
                  {it.txHash && it.txHash !== "0x" ? (
                    <>
                      {" · "}
                      <TxLink hash={it.txHash}>tx</TxLink>
                    </>
                  ) : null}
                </span>
              </span>
              <span className="text-right">
                <span className="block font-mono num">{it.rawAmount && it.decimals !== undefined ? `${formatTokenAmount(it.rawAmount, it.decimals)} ${asset.underlying}` : "—"}</span>
                {it.amountUsd !== undefined && <span className="block font-mono text-[11px] text-ink-muted">{formatUsd(it.amountUsd)}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

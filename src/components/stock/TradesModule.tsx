"use client";

import Link from "next/link";
import type { Address } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { ActivityItem, ActivityLeg } from "@/domain/activity";
import { useActivity } from "@/hooks/queries";
import { formatTokenAmount, formatUsd, timeAgo } from "@/lib/format";
import { Skeleton, cx } from "@/components/ui/primitives";
import { TxLink } from "@/components/common/display";
import { counterpartyLabel } from "@/components/activity/ActivityList";

const LABEL: Record<string, string> = { buy: "Bought", sell: "Sold", send: "Sent", receive: "Received", "portfolio-build": "Basket buy", "auto-invest": "Auto-invest buy", "pool-create": "Funded a pool", "pool-claim": "Pool share" };

/**
 * Below "Your position": this wallet's own trades, sends and receipts of the stock, from the
 * activity timeline. A basket or an AutoInvest run is one row there; here it contributes the one
 * leg that concerns this stock.
 */
export function TradesModule({ asset, user }: { asset: B20AssetDTO; user?: Address }) {
  const activity = useActivity(user);
  if (!user) return null;
  const mine = (activity.data ?? [])
    .flatMap((it): Array<{ it: ActivityItem; leg?: ActivityLeg }> => {
      if (it.assetAddress?.toLowerCase() === asset.canonicalId) return [{ it }];
      const leg = it.legs?.find((l) => l.assetAddress.toLowerCase() === asset.canonicalId);
      return leg ? [{ it, leg }] : [];
    })
    .slice(0, 8);
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
          {mine.map(({ it, leg }) => {
            const failed = leg ? leg.status === "failed" : Boolean(it.metadata?.failed);
            const pending = leg ? leg.status === "pending" : !it.verified && it.source === "app";
            const raw = leg ? leg.rawAmount : it.rawAmount;
            const decimals = leg ? leg.decimals : it.decimals;
            const usd = leg ? leg.amountUsd : it.amountUsd;
            const hash = leg?.txHash ?? it.txHash;
            const positive = it.type === "buy" || it.type === "receive" || it.type === "portfolio-build" || it.type === "auto-invest" || it.type === "pool-claim";
            const negative = it.type === "sell" || it.type === "send" || it.type === "pool-create";
            return (
              <li key={`${it.id}:${leg?.txHash ?? ""}`} className="px-4 md:px-5 py-2 grid grid-cols-[1fr_auto] gap-3 text-[13px] items-center">
                <span className="min-w-0">
                  <span className={cx("font-medium", failed ? "text-ink-muted line-through" : positive ? "text-positive-fg" : negative ? "text-danger-fg" : "")}>{LABEL[it.type] ?? it.type}</span>
                  {it.counterparty && (it.type === "send" || it.type === "receive") ? <span className="text-ink-secondary"> {it.type === "send" ? "to" : "from"} {counterpartyLabel(it)}</span> : null}
                  <span className="block font-mono text-[11px] text-ink-muted">
                    {it.timestamp ? timeAgo(it.timestamp) : it.blockNumber ? `block ${it.blockNumber}` : "pending"}
                    {(leg?.provider ?? it.provider) ? ` · ${leg?.provider ?? it.provider}` : ""}
                    {failed ? " · failed" : pending ? " · pending" : ""}
                    {hash && hash !== "0x" ? (
                      <>
                        {" · "}
                        <TxLink hash={hash}>tx</TxLink>
                      </>
                    ) : null}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-mono num">{raw && decimals !== undefined ? `${formatTokenAmount(raw, decimals)} ${asset.underlying}` : "—"}</span>
                  {usd !== undefined && <span className="block font-mono text-[11px] text-ink-muted">{formatUsd(usd)}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

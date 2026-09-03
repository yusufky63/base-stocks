"use client";

import { Gift } from "lucide-react";
import type { ActivityItem } from "@/domain/activity";
import { formatTokenAmount, formatUsd, shortenAddress, timeAgo } from "@/lib/format";
import { Badge, cx } from "@/components/ui/primitives";
import { TxLink } from "@/components/common/display";
import { ShareButton } from "@/components/common/ShareSheet";

const LABELS: Record<ActivityItem["type"], string> = {
  buy: "Bought",
  sell: "Sold",
  send: "Sent",
  receive: "Received",
  "portfolio-build": "Built portfolio",
  "earn-supply": "Deposited USDC",
  "earn-withdraw": "Withdrew USDC",
  "earn-liquidity": "Added liquidity",
  approve: "Approved",
  unknown: "Activity",
};

/** Basename, then BStocks handle, then the short address. */
export function counterpartyLabel(it: Pick<ActivityItem, "counterparty" | "counterpartyBasename" | "counterpartyHandle">): string {
  if (it.counterpartyBasename) return it.counterpartyBasename;
  if (it.counterpartyHandle) return `@${it.counterpartyHandle}`;
  return it.counterparty ? shortenAddress(it.counterparty) : "";
}

export function ActivityList({ items, compact = false }: { items: ActivityItem[]; compact?: boolean }) {
  if (items.length === 0) return <p className="px-4 py-4 text-[14px] text-ink-secondary">No activity yet.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((it) => {
        const transfer = it.type === "send" || it.type === "receive";
        const giftId = typeof it.metadata?.giftId === "string" ? it.metadata.giftId : null;
        const message = typeof it.metadata?.message === "string" && it.metadata.message ? it.metadata.message : null;
        const symbol = it.symbol?.replace(/c$/, "") ?? "";
        const amount = it.rawAmount && it.decimals !== undefined ? `${formatTokenAmount(it.rawAmount, it.decimals)} ${symbol}` : symbol;
        const who = counterpartyLabel(it);
        const shareText = it.type === "receive" ? `I received ${amount} as a gift from ${who} on BStocks — tokenized stocks on Base.` : `I just sent ${amount} (a tokenized stock on Base) to ${who} with BStocks.`;
        return (
          <li key={it.id} className={cx("px-4 flex items-center justify-between gap-3", compact ? "py-2.5" : "py-3")}>
            <div className="min-w-0">
              <div className="text-[14px] font-medium truncate flex items-center gap-1.5">
                {giftId && <Gift size={13} strokeWidth={2} className="text-primary shrink-0" aria-label="Gift" />}
                <span className="truncate">
                  {LABELS[it.type]} {symbol}
                  {it.counterparty && transfer && (
                    <span className="text-ink-secondary font-normal">
                      {" "}
                      {it.type === "send" ? "to" : "from"} {who}
                    </span>
                  )}
                  {it.type.startsWith("earn") && (it.metadata?.title || it.provider) ? <span className="text-ink-secondary font-normal"> · {String(it.metadata?.title ?? it.provider)}</span> : null}
                </span>
              </div>
              {message && !compact && <p className="text-[13px] text-ink-secondary truncate">“{message}”</p>}
              <div className="text-[12px] text-ink-muted font-mono flex items-center gap-2">
                <span>{it.timestamp ? timeAgo(it.timestamp) : it.blockNumber ? `block ${it.blockNumber}` : "pending"}</span>
                {giftId && <Badge tone="primary">gift</Badge>}
                {it.metadata?.status === "failed" || (it.type !== "portfolio-build" && it.source === "app" && it.metadata?.failed) ? (
                  <Badge tone="danger">failed</Badge>
                ) : !it.verified && it.source === "app" ? (
                  <Badge tone="warning">pending verification</Badge>
                ) : null}
                {it.txHash && it.txHash !== "0x" && !compact && <TxLink hash={it.txHash}>tx</TxLink>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="text-right">
                {it.amountUsd !== undefined ? <div className="display num text-[15px]">{formatUsd(it.amountUsd)}</div> : null}
                {it.rawAmount && it.decimals !== undefined && <div className="font-mono num text-[12px] text-ink-secondary">{formatTokenAmount(it.rawAmount, it.decimals)}</div>}
              </div>
              {giftId && !compact && <ShareButton iconOnly path={`/gifts/${giftId}`} text={shareText} title={it.type === "receive" ? "Share this gift" : "Share your gift"} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

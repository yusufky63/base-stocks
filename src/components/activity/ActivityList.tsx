"use client";

import { ArrowDownLeft, ArrowUpRight, Check, Gift, Layers, Sparkles } from "lucide-react";
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

/**
 * Which way the value moved, which is the one thing every row has in common and the fastest thing
 * to read. "in" is stock or yield arriving, "out" is it leaving; the rest are neither.
 */
type Direction = "in" | "out" | "neutral";

const DIRECTION: Record<ActivityItem["type"], Direction> = {
  buy: "in",
  receive: "in",
  "earn-supply": "out",
  "earn-liquidity": "out",
  "earn-withdraw": "in",
  sell: "out",
  send: "out",
  "portfolio-build": "in",
  approve: "neutral",
  unknown: "neutral",
};

const ICONS: Record<ActivityItem["type"], typeof ArrowDownLeft> = {
  buy: ArrowDownLeft,
  receive: ArrowDownLeft,
  sell: ArrowUpRight,
  send: ArrowUpRight,
  "earn-supply": Sparkles,
  "earn-liquidity": Sparkles,
  "earn-withdraw": Sparkles,
  "portfolio-build": Layers,
  approve: Check,
  unknown: Check,
};

/** Basename, then the short address. */
export function counterpartyLabel(it: Pick<ActivityItem, "counterparty" | "counterpartyBasename">): string {
  if (it.counterpartyBasename) return it.counterpartyBasename;
  return it.counterparty ? shortenAddress(it.counterparty) : "";
}

/**
 * A tinted square carrying the shape of the action.
 *
 * Every row used to be a line of prose, so a purchase, a gift and a liquidity deposit all scanned
 * the same and the only way to tell them apart was to read. The icon does that at a glance and the
 * tint says which way the money went; a gift keeps its own mark, because that is the thing about it
 * worth noticing first.
 */
function ActivityIcon({ type, gift, failed, compact }: { type: ActivityItem["type"]; gift: boolean; failed: boolean; compact: boolean }) {
  const Icon = gift ? Gift : ICONS[type];
  const tone = failed ? "border-danger text-danger-fg bg-canvas" : gift ? "border-primary text-primary bg-primary-soft" : DIRECTION[type] === "in" ? "border-positive text-positive-fg bg-positive-soft" : DIRECTION[type] === "out" ? "border-line-strong text-ink-secondary bg-surface" : "border-line text-ink-muted bg-surface";
  return (
    <span aria-hidden className={cx("shrink-0 inline-flex items-center justify-center rounded-[6px] border", tone, compact ? "h-8 w-8" : "h-9 w-9")}>
      <Icon size={compact ? 14 : 16} strokeWidth={1.75} />
    </span>
  );
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
        const failed = it.metadata?.status === "failed" || (it.type !== "portfolio-build" && it.source === "app" && Boolean(it.metadata?.failed));
        const direction = DIRECTION[it.type];
        // A failed transaction moved nothing, so it gets no sign: the figure is what was attempted,
        // and "+$2.00" on a buy that reverted reads as money that arrived.
        const sign = failed ? "" : direction === "in" ? "+" : direction === "out" ? "−" : "";
        const pending = !failed && !it.verified && it.source === "app";
        const tokenAmount = it.rawAmount && it.decimals !== undefined ? formatTokenAmount(it.rawAmount, it.decimals) : null;
        const shareText = it.type === "receive" ? `I received ${amount} as a gift from ${who} on BStocks — tokenized stocks on Base.` : `I just sent ${amount} (a tokenized stock on Base) to ${who} with BStocks.`;
        return (
          <li key={it.id} className={cx("px-4 flex items-center gap-3", compact ? "py-2.5" : "py-3")}>
            <ActivityIcon type={it.type} gift={Boolean(giftId)} failed={failed} compact={compact} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium truncate flex items-center gap-1.5">
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
                {/* Three states, and only two of them need saying. A confirmed row is the ordinary
                    case and carries no badge; "Pending" now means the transaction is not mined yet,
                    which the receipt settles within a block or two, rather than meaning our own
                    bookkeeping has not caught up. */}
                {failed ? <Badge tone="danger">Failed</Badge> : pending ? <Badge tone="warning">Pending</Badge> : null}
                {it.txHash && it.txHash !== "0x" && !compact && <TxLink hash={it.txHash}>tx</TxLink>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* One figure when the row is compact: the dollar value if there is one, the units
                  otherwise. Printing both in a five-row summary is repetition, not information. */}
              <div className="text-right">
                {it.amountUsd !== undefined && <div className={cx("display num text-[15px] whitespace-nowrap", failed && "text-ink-muted line-through")}>{`${sign}${formatUsd(it.amountUsd)}`}</div>}
                {tokenAmount && (it.amountUsd === undefined || !compact) && (
                  <div className={cx("font-mono num text-ink-secondary whitespace-nowrap", it.amountUsd === undefined ? "text-[15px]" : "text-[12px]")}>{`${it.amountUsd === undefined ? sign : ""}${tokenAmount} ${symbol}`}</div>
                )}
              </div>
              {giftId && !compact && <ShareButton iconOnly path={`/gifts/${giftId}`} text={shareText} title={it.type === "receive" ? "Share this gift" : "Share your gift"} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

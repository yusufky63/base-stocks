"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Check, Gift, Layers, Repeat, Sparkles } from "lucide-react";
import type { ActivityItem } from "@/domain/activity";
import { formatTokenAmount, formatUsd, shortenAddress, timeAgo } from "@/lib/format";
import { scaledAmount } from "@/lib/gift/format";
import { Badge, cx } from "@/components/ui/primitives";
import { TxLink } from "@/components/common/display";
import { ShareButton } from "@/components/common/ShareSheet";
import { GIFT_ESCROW_ADDRESS, LEGACY_GIFT_ESCROW_ADDRESSES } from "@/lib/escrow";
import { GIFT_POOL_ADDRESS, LEGACY_GIFT_POOL_ADDRESSES } from "@/lib/pool";
import { AUTO_INVEST_ADDRESS, LEGACY_AUTO_INVEST_ADDRESSES } from "@/lib/auto-invest";

const LABELS: Record<ActivityItem["type"], string> = {
  buy: "Bought",
  sell: "Sold",
  send: "Sent",
  receive: "Received",
  "portfolio-build": "Built portfolio",
  "auto-invest": "Auto-invest run",
  "earn-supply": "Deposited USDC",
  "earn-withdraw": "Withdrew USDC",
  "earn-liquidity": "Added liquidity",
  "earn-collect": "Collected fees",
  "pool-create": "Funded a gift pool",
  "pool-claim": "Claimed a pool share",
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
  "earn-collect": "in",
  sell: "out",
  send: "out",
  "portfolio-build": "in",
  "auto-invest": "in",
  "pool-create": "out",
  "pool-claim": "in",
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
  "earn-collect": Sparkles,
  "portfolio-build": Layers,
  "auto-invest": Repeat,
  "pool-create": Gift,
  "pool-claim": Gift,
  approve: Check,
  unknown: Check,
};

/** The app's own contracts, so a transfer the scan found on its own still reads as what it was. */
// Every deployment the app has used, so a transfer that touched a first-generation contract is
// still named rather than shown as a stranger's address.
const CONTRACT_LABEL: Record<string, string> = {
  ...Object.fromEntries(LEGACY_GIFT_ESCROW_ADDRESSES.map((a) => [a.toLowerCase(), "the gift escrow (legacy)"])),
  ...Object.fromEntries(LEGACY_GIFT_POOL_ADDRESSES.map((a) => [a.toLowerCase(), "the gift pool contract (legacy)"])),
  [GIFT_ESCROW_ADDRESS.toLowerCase()]: "the gift escrow",
  ...(GIFT_POOL_ADDRESS ? { [GIFT_POOL_ADDRESS.toLowerCase()]: "the gift pool contract" } : {}),
  ...Object.fromEntries(LEGACY_AUTO_INVEST_ADDRESSES.map((a) => [a.toLowerCase(), "the AutoInvest contract (legacy)"])),
  ...(AUTO_INVEST_ADDRESS ? { [AUTO_INVEST_ADDRESS.toLowerCase()]: "the AutoInvest contract" } : {}),
};

/** Basename, then the app's own contracts by name, then the short address. */

/** Raw B20 units as share-equivalents when the multiplier is known; raw units otherwise (identical while every multiplier is 1×). */
function shares(raw: string, decimals: number, multiplier?: string, wadPrecision?: string): string {
  return formatTokenAmount(multiplier && wadPrecision ? scaledAmount(raw, multiplier, wadPrecision) : raw, decimals);
}

export function counterpartyLabel(it: Pick<ActivityItem, "counterparty" | "counterpartyBasename">): string {
  if (it.counterpartyBasename) return it.counterpartyBasename;
  if (!it.counterparty) return "";
  return CONTRACT_LABEL[it.counterparty.toLowerCase()] ?? shortenAddress(it.counterparty);
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** The stock's ticker without the B20 "c" suffix. */
export function displaySymbol(symbol: string | undefined): string {
  return symbol?.replace(/c$/, "") ?? "";
}

/**
 * The first line of a row, in words. One transaction is one row, so a basket, an AutoInvest run
 * or ten gift links funded together each read as the one thing they were.
 */
export function headline(it: ActivityItem): { title: string; aside?: string } {
  const symbol = displaySymbol(it.symbol);
  const who = counterpartyLabel(it);
  const kind = str(it.metadata?.kind);
  const status = str(it.metadata?.status);
  const legs = it.legs ?? [];
  switch (it.type) {
    case "portfolio-build":
      return { title: "Built portfolio", aside: `${num(it.metadata?.completed) ?? legs.filter((l) => l.status === "confirmed").length} of ${num(it.metadata?.total) ?? legs.length} legs` };
    case "auto-invest":
      return { title: "Auto-invest run", aside: `${legs.length} stock${legs.length === 1 ? "" : "s"}` };
    case "pool-create":
      return { title: "Funded a gift pool", aside: `${num(it.metadata?.slots) ?? "?"} shares · ${legs.length > 1 ? `${legs.length} stocks` : symbol}` };
    case "pool-claim":
      return { title: `Claimed a pool share${legs.length > 1 ? ` · ${legs.length} stocks` : symbol ? ` · ${symbol}` : ""}`, aside: who ? `from ${who}` : undefined };
    case "send":
      if (kind === "claim-link") {
        const count = it.count ?? 1;
        if (count > 1) return { title: `Funded ${count} gift links · ${symbol}`, aside: `${num(it.metadata?.claimed) ?? 0} claimed` };
        if (status === "claimed") return { title: `Gift link claimed · ${symbol}`, aside: who ? `by ${who}` : undefined };
        if (status === "reclaimed") return { title: `Gift link cancelled · ${symbol}`, aside: "stock returned" };
        return { title: `Gift link · ${symbol}`, aside: "waiting to be claimed" };
      }
      return { title: `Sent ${symbol}`, aside: who ? `to ${who}` : undefined };
    case "receive":
      if (kind === "claim-link") return { title: `Claimed a gift · ${symbol}`, aside: who ? `from ${who}` : undefined };
      return { title: `Received ${symbol}`, aside: who ? `from ${who}` : undefined };
    case "earn-supply":
    case "earn-withdraw":
    case "earn-liquidity":
    case "earn-collect":
      // A liquidity position moves stock as well as USDC, so its withdrawal is not "Withdrew USDC".
      return { title: it.type === "earn-withdraw" && it.metadata?.lp === true ? "Withdrew liquidity" : LABELS[it.type], aside: str(it.metadata?.title) ?? it.provider ?? undefined };
    default:
      return { title: `${LABELS[it.type]} ${symbol}`.trim() };
  }
}

/** Legs of a grouped row, in one line: "AAPL $1.80 · NVDA $1.80 · MSFT failed". */
function legsLine(it: ActivityItem): string | null {
  if (!it.legs || it.legs.length === 0) return null;
  return it.legs
    .map((l) => {
      const s = displaySymbol(l.symbol);
      if (l.status === "failed") return `${s} failed`;
      const amount = l.amountUsd !== undefined ? formatUsd(l.amountUsd) : l.rawAmount && l.decimals !== undefined ? shares(l.rawAmount, l.decimals, l.multiplier, l.wadPrecision) : "";
      return `${s}${amount ? ` ${amount}` : ""}${l.status === "pending" ? " (pending)" : ""}`;
    })
    .join(" · ");
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

export function ActivityList({ items, compact = false, emptyHint }: { items: ActivityItem[]; compact?: boolean; emptyHint?: "story" }) {
  if (items.length === 0)
    return emptyHint === "story" ? (
      <div className="px-4 py-5 flex flex-col gap-3 items-start">
        <p className="text-[14px] text-ink-secondary max-w-[52ch]">Your first buy shows up here, checked against its receipt on Base. Tokenized stocks start from about a dollar, and a gift you receive lands here too.</p>
        <div className="flex gap-2 flex-wrap">
          <Link href="/markets" className="inline-flex items-center h-9 px-3 rounded-[6px] text-[13px] font-medium bg-primary text-primary-contrast hover:bg-primary-strong transition-fast">
            Browse markets
          </Link>
          <Link href="/build" className="inline-flex items-center h-9 px-3 rounded-[6px] text-[13px] font-medium border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
            Build a basket
          </Link>
        </div>
      </div>
    ) : (
      <p className="px-4 py-4 text-[14px] text-ink-secondary">No activity yet.</p>
    );
  return (
    <ul className="divide-y divide-line">
      {items.map((it) => {
        const giftId = str(it.metadata?.giftId);
        const kind = str(it.metadata?.kind);
        const isGift = Boolean(giftId) || kind === "claim-link" || it.type === "pool-create" || it.type === "pool-claim";
        const message = compact ? null : str(it.metadata?.message);
        const symbol = displaySymbol(it.symbol);
        const amount = it.rawAmount && it.decimals !== undefined ? `${shares(it.rawAmount, it.decimals, it.multiplier, it.wadPrecision)} ${symbol}` : symbol;
        const who = counterpartyLabel(it);
        const failed = it.metadata?.status === "failed" || (it.source === "app" && Boolean(it.metadata?.failed));
        const reclaimed = it.metadata?.status === "reclaimed";
        const direction: Direction = reclaimed ? "neutral" : DIRECTION[it.type];
        // A failed transaction moved nothing, so it gets no sign: the figure is what was attempted,
        // and "+$2.00" on a buy that reverted reads as money that arrived.
        const sign = failed ? "" : direction === "in" ? "+" : direction === "out" ? "−" : "";
        const pending = !failed && !it.verified && it.source === "app";
        const tokenAmount = it.rawAmount && it.decimals !== undefined ? shares(it.rawAmount, it.decimals, it.multiplier, it.wadPrecision) : null;
        const { title, aside } = headline(it);
        const legs = compact ? null : legsLine(it);
        const shareText = it.type === "receive" ? `I received ${amount} as a gift from ${who} on BaseStocks — tokenized stocks on Base.` : `I just sent ${amount} (a tokenized stock on Base) to ${who} with BaseStocks.`;
        return (
          <li key={it.id} className={cx("px-4 flex items-center gap-3", compact ? "py-2.5" : "py-3")}>
            <ActivityIcon type={it.type} gift={isGift} failed={failed} compact={compact} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium truncate flex items-center gap-1.5">
                <span className="truncate">
                  {title}
                  {aside && <span className="text-ink-secondary font-normal"> · {aside}</span>}
                </span>
              </div>
              {message && <p className="text-[13px] text-ink-secondary truncate">“{message}”</p>}
              {legs && <p className="text-[12px] text-ink-secondary truncate font-mono num">{legs}</p>}
              <div className="text-[12px] text-ink-muted font-mono flex items-center gap-2">
                <span>{it.timestamp ? timeAgo(it.timestamp) : it.blockNumber ? `block ${it.blockNumber}` : "pending"}</span>
                {/* Three states, and only two of them need saying. A confirmed row is the ordinary
                    case and carries no badge; "Pending" means the transaction is not mined yet,
                    which the receipt settles within a block or two. */}
                {failed ? <Badge tone="danger">Failed</Badge> : pending ? <Badge tone="warning">Pending</Badge> : null}
                {reclaimed && !failed && <Badge>Cancelled</Badge>}
                {it.txHash && it.txHash !== "0x" && !compact && <TxLink hash={it.txHash}>tx</TxLink>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* One figure when the row is compact: the dollar value if there is one, the units
                  otherwise. Printing both in a five-row summary is repetition, not information. */}
              <div className="text-right">
                {it.amountUsd !== undefined && <div className={cx("display num text-[15px] whitespace-nowrap", failed && "text-ink-muted line-through")}>{`${sign}${formatUsd(it.amountUsd)}`}</div>}
                {tokenAmount && (it.amountUsd === undefined || !compact) && (
                  <div className={cx("font-mono num text-ink-secondary whitespace-nowrap", it.amountUsd === undefined ? "text-[15px]" : "text-[12px]", failed && "line-through")}>{`${it.amountUsd === undefined ? sign : ""}${tokenAmount} ${symbol}`}</div>
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

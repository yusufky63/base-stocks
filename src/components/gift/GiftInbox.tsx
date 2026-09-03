"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Gift, X } from "lucide-react";
import type { Address } from "viem";
import { useActivity } from "@/hooks/queries";
import { coinSrc } from "@/lib/coins";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { counterpartyLabel } from "@/components/activity/ActivityList";
import { Avatar } from "@/components/common/RecipientCard";
import { TimeAgo } from "@/components/common/TimeAgo";
import { ShareButton } from "@/components/common/ShareSheet";
import { Button } from "@/components/ui/primitives";

const KEY = "bstocks.gifts.seen";

function readSeen(): Set<string> {
  try {
    if (typeof window === "undefined") return new Set();
    return new Set<string>(JSON.parse(window.localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function writeSeen(seen: Set<string>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* storage blocked: the banner simply shows again next time */
  }
}

/**
 * "Someone sent you stock": gift records where this wallet is the recipient and the banner has
 * not been dismissed on this device. Each gift is a card with the coin, the sender (Basename or
 * address), value, message and a link to the receipt page.
 */
export function GiftInbox({ address, onOpenActivity }: { address: Address; onOpenActivity?: () => void }) {
  const { data } = useActivity(address);
  const [seen, setSeen] = useState<Set<string>>(() => readSeen());
  if (!data) return null;
  const received = data.filter((it) => it.type === "receive" && typeof it.metadata?.giftId === "string" && !seen.has(String(it.metadata.giftId)) && !it.metadata?.failed);
  if (received.length === 0) return null;
  const ids = received.map((r) => String(r.metadata!.giftId));
  const dismiss = () => {
    const next = new Set(seen);
    ids.forEach((i) => next.add(i));
    writeSeen(next);
    setSeen(next);
  };
  const dismissOne = (giftId: string) => {
    const next = new Set(seen);
    next.add(giftId);
    writeSeen(next);
    setSeen(next);
  };

  return (
    <div className="border border-primary/40 bg-primary-soft/40 rounded-[8px] overflow-hidden" role="status">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 font-medium text-[14px]">
          <span className="h-7 w-7 rounded-full bg-primary text-primary-contrast inline-flex items-center justify-center shrink-0">
            <Gift size={14} strokeWidth={2} />
          </span>
          {received.length === 1 ? "You received a gift" : `You received ${received.length} gifts`}
        </div>
        <div className="flex items-center gap-1">
          {onOpenActivity && (
            <Button variant="ghost" size="sm" onClick={onOpenActivity}>
              All activity
            </Button>
          )}
          <button type="button" aria-label="Dismiss all" title="Dismiss all" onClick={dismiss} className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 px-3 pb-3">
        {received.slice(0, 4).map((it) => {
          const giftId = String(it.metadata!.giftId);
          const symbol = it.symbol?.replace(/c$/, "") ?? "";
          const amount = it.rawAmount && it.decimals !== undefined ? `${formatTokenAmount(it.rawAmount, it.decimals)} ${symbol}` : symbol;
          const who = counterpartyLabel(it);
          const message = typeof it.metadata?.message === "string" && it.metadata.message ? it.metadata.message : null;
          const coin = coinSrc(symbol, "small");
          return (
            <li key={it.id} className="rail bg-canvas border border-line rounded-[8px] p-3 flex items-center gap-3 min-w-0">
              {coin ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={coin} alt="" width={44} height={44} className="w-11 h-11 shrink-0" />
              ) : (
                <span className="w-11 h-11 rounded-full bg-primary-soft inline-flex items-center justify-center shrink-0">
                  <Gift size={18} strokeWidth={1.75} className="text-primary" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block display num text-[16px] leading-tight truncate">
                  {amount}
                  {it.amountUsd !== undefined && <span className="font-sans text-[12px] text-ink-secondary font-normal tracking-normal">{` · ${formatUsd(it.amountUsd)}`}</span>}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-secondary min-w-0">
                  {it.counterparty && <Avatar seed={it.counterparty} label={who} size={16} />}
                  <span className="truncate">{`from ${who}`}</span>
                  {it.timestamp !== undefined && (
                    <span className="text-ink-muted shrink-0">
                      · <TimeAgo value={it.timestamp} />
                    </span>
                  )}
                  {!it.verified && <span className="text-ink-muted shrink-0">· confirming</span>}
                </span>
                {message && <span className="block text-[12px] text-ink-secondary italic truncate">“{message}”</span>}
              </span>
              <span className="flex items-center gap-1 shrink-0">
                <Link href={`/gifts/${giftId}`} className="inline-flex items-center gap-1 h-9 px-2.5 rounded-[6px] text-[12px] font-medium text-primary hover:bg-primary-soft transition-fast" onClick={() => dismissOne(giftId)}>
                  View <ArrowUpRight size={13} strokeWidth={2} />
                </Link>
                <ShareButton iconOnly path={`/gifts/${giftId}`} text={`I received ${amount} as a gift from ${who} on BStocks — tokenized stocks on Base.`} title="Share this gift" />
              </span>
            </li>
          );
        })}
      </ul>
      {received.length > 4 && <p className="px-4 pb-3 -mt-1 text-[12px] text-ink-muted">{`+ ${received.length - 4} more in activity`}</p>}
    </div>
  );
}

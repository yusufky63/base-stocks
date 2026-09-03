"use client";

import { useState } from "react";
import { Gift, X } from "lucide-react";
import type { Address } from "viem";
import { useActivity } from "@/hooks/queries";
import { formatTokenAmount } from "@/lib/format";
import { counterpartyLabel } from "@/components/activity/ActivityList";
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
 * not been dismissed on this device. Sender is shown as Basename / BStocks handle / address.
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
  return (
    <div className="border border-primary/40 bg-primary-soft/40 rounded-[8px] p-4 flex flex-col gap-3" role="status">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-medium text-[14px]">
          <Gift size={16} strokeWidth={2} className="text-primary" /> {received.length === 1 ? "You received a gift" : `You received ${received.length} gifts`}
        </div>
        <button type="button" aria-label="Dismiss" onClick={dismiss} className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <ul className="flex flex-col gap-2">
        {received.slice(0, 3).map((it) => {
          const giftId = String(it.metadata!.giftId);
          const symbol = it.symbol?.replace(/c$/, "") ?? "";
          const amount = it.rawAmount && it.decimals !== undefined ? `${formatTokenAmount(it.rawAmount, it.decimals)} ${symbol}` : symbol;
          const who = counterpartyLabel(it);
          const message = typeof it.metadata?.message === "string" && it.metadata.message ? it.metadata.message : null;
          return (
            <li key={it.id} className="flex items-center justify-between gap-3 text-[13px]">
              <span className="min-w-0">
                <span className="block truncate">
                  <span className="font-medium">{who}</span>
                  {it.counterpartyHandle ? <span className="text-ink-muted"> · BStocks member</span> : null} sent you <span className="font-mono num">{amount}</span>
                  {!it.verified && <span className="text-ink-muted"> · confirming</span>}
                </span>
                {message && <span className="block text-ink-secondary truncate">“{message}”</span>}
              </span>
              <ShareButton iconOnly path={`/gifts/${giftId}`} text={`I received ${amount} as a gift from ${who} on BStocks — tokenized stocks on Base.`} title="Share this gift" />
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2">
        {onOpenActivity && (
          <Button variant="secondary" size="sm" onClick={onOpenActivity}>
            See in activity
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={dismiss}>
          Got it
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Check, Copy, Link2, Megaphone } from "lucide-react";
import type { Address } from "viem";
import { publicEnv } from "@/config/env";
import { shortenAddress } from "@/lib/format";
import { ShareButton } from "@/components/common/ShareSheet";
import { cx } from "@/components/ui/primitives";

const AMBASSADOR_TARGET = 3;

/**
 * Referral panel: the link with the wallet's tag, one-tap copy and share, the two counters that
 * matter (invited, traded) and how far the Ambassador badge is. Owner view shows the link; the
 * public view shows only the counters.
 */
export function ReferralCard({ address, invited, traded, owner = true }: { address: Address; invited: number; traded: number; owner?: boolean }) {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : publicEnv.appUrl;
  const link = `${origin}/?ref=${address}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the link stays visible */
    }
  };
  const pct = Math.min(100, Math.round((traded / AMBASSADOR_TARGET) * 100));
  return (
    <div className="p-4 flex flex-col gap-4">
      {owner && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 border border-line rounded-[6px] px-3 h-11 bg-surface">
            <Link2 size={14} strokeWidth={1.75} className="text-ink-muted shrink-0" />
            <code className="font-mono text-[12px] text-ink truncate flex-1">{link.replace(/^https?:\/\//, "")}</code>
            <button type="button" onClick={copy} aria-label="Copy referral link" className="shrink-0 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">
              {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <ShareButton path="/" text="Tokenized stocks on Base, held in your own wallet. I use BStocks:" title="Share your referral link" size="sm" label="Share link" />
            <span className="text-[12px] text-ink-muted">Every stock, basket and gift you share already carries your tag ({shortenAddress(address, 4)}).</span>
          </div>
        </div>
      )}

      <div className="module-grid grid-cols-3">
        <div className="p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Invited</div>
          <div className="display num text-[24px]">{invited}</div>
          <div className="text-[11px] text-ink-muted">wallets that signed in through the link</div>
        </div>
        <div className="p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">Traded</div>
          <div className="display num text-[24px]">{traded}</div>
          <div className="text-[11px] text-ink-muted">of them made a first trade</div>
        </div>
        <div className="p-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted inline-flex items-center gap-1">
            <Megaphone size={11} strokeWidth={2} /> Ambassador
          </div>
          <div className="display num text-[24px]">{Math.min(traded, AMBASSADOR_TARGET)}/{AMBASSADOR_TARGET}</div>
          <span className="block h-1 mt-1 rounded-full bg-surface-muted overflow-hidden" aria-hidden>
            <span className={cx("block h-full rounded-full", traded >= AMBASSADOR_TARGET ? "bg-primary" : "bg-ink-muted/60")} style={{ width: `${pct}%` }} />
          </span>
        </div>
      </div>

      <ol className="text-[12px] text-ink-secondary flex flex-col gap-1 list-decimal pl-4">
        <li>Someone opens a link with your tag; it is kept on their device for 30 days.</li>
        <li>They connect and sign in; the wallet counts as invited.</li>
        <li>Their first confirmed trade counts as traded. Three of those earn the Ambassador badge.</li>
      </ol>
      <p className="text-[11px] text-ink-muted">Badges only: no fees are shared and nothing is paid out.</p>
    </div>
  );
}

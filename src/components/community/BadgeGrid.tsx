"use client";

import { Blocks, Gift, Layers, PenLine, Star, Zap, type LucideIcon } from "lucide-react";
import type { Badge as BadgeT } from "@/domain/community";
import { timeAgo } from "@/lib/format";
import { cx } from "@/components/ui/primitives";

const ICON: Record<string, LucideIcon> = { "first-trade": Zap, diversified: Layers, builder: Blocks, gifter: Gift, curator: PenLine, popular: Star };
const HOW: Record<string, string> = {
  "first-trade": "Buy or sell any tokenized stock here.",
  diversified: "Hold five different stocks bought here.",
  builder: "Execute a basket from Build.",
  gifter: "Send stock to a Basename or address.",
  curator: "Publish a basket to the community.",
  popular: "Get ten votes on a published basket.",
};

/**
 * Badges as a grid of small cards: earned ones are lit with their date; locked ones show how far
 * along the wallet is (server-computed progress) and what unlocks them. No monetary rewards.
 */
export function BadgeGrid({ badges, compact = false }: { badges: BadgeT[]; compact?: boolean }) {
  const earned = badges.filter((b) => b.earned).length;
  const sorted = [...badges].sort((a, b) => Number(b.earned) - Number(a.earned) || (b.progress ? b.progress.current / b.progress.target : 0) - (a.progress ? a.progress.current / a.progress.target : 0));
  return (
    <div className="p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between text-[12px]">
        <span className="text-ink-secondary">
          <span className="font-medium text-ink">{earned}</span> of {badges.length} earned
        </span>
        <span className="flex-1 mx-3 h-1 rounded-full bg-surface-muted overflow-hidden" aria-hidden>
          <span className="block h-full bg-primary rounded-full" style={{ width: `${badges.length ? (earned / badges.length) * 100 : 0}%` }} />
        </span>
        <span className="font-mono text-[11px] text-ink-muted">badges only · no rewards</span>
      </div>
      <ul className={cx("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-3")}>
        {sorted.map((b) => {
          const Icon = ICON[b.id] ?? Star;
          const pct = b.progress ? Math.min(100, Math.round((b.progress.current / b.progress.target) * 100)) : b.earned ? 100 : 0;
          return (
            <li key={b.id} className={cx("border rounded-[8px] p-3 flex flex-col gap-2", b.earned ? "border-primary bg-primary-soft/60" : "border-line")}>
              <div className="flex items-center gap-2">
                <span className={cx("h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-full border", b.earned ? "border-primary bg-primary text-primary-contrast" : "border-line text-ink-muted")}>
                  <Icon size={15} strokeWidth={1.75} />
                </span>
                <span className="min-w-0">
                  <span className={cx("block text-[13px] font-medium truncate", !b.earned && "text-ink-secondary")}>{b.label}</span>
                  <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">{b.earned ? (b.earnedAt ? `earned ${timeAgo(b.earnedAt)}` : "earned") : b.progress ? `${b.progress.current} of ${b.progress.target}` : "locked"}</span>
                </span>
              </div>
              {!b.earned && (
                <span className="h-1 rounded-full bg-surface-muted overflow-hidden" aria-hidden>
                  <span className="block h-full bg-ink-muted/60 rounded-full" style={{ width: `${pct}%` }} />
                </span>
              )}
              <span className="text-[11px] text-ink-secondary leading-snug">{b.earned ? b.description : (HOW[b.id] ?? b.description)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

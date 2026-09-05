"use client";

import { X } from "lucide-react";
import type { AssetsResponse } from "@/lib/client-api";
import type { SavedBasket } from "@/lib/recent-baskets";
import { bpsToPct, timeAgo } from "@/lib/format";
import { AllocationBar } from "@/components/common/AllocationBar";
import { Badge } from "@/components/ui/primitives";

const SOURCE_LABEL = { ai: "AI draft", template: "Template", custom: "Your own" } as const;

/**
 * The last baskets this device drafted, bought, published or sent to Automate. Tap one to put it
 * back in the editor. Nothing here has left the browser.
 */
export function RecentBaskets({ items, assets, disabled, onLoad, onForget }: { items: SavedBasket[]; assets?: AssetsResponse; disabled?: boolean; onLoad: (b: SavedBasket) => void; onForget: (id: string) => void }) {
  if (items.length === 0) {
    return <p className="text-[13px] text-ink-secondary">Nothing here yet. Baskets you draft, buy, publish or send to Automate are kept on this device and listed here, and the one you are working on comes back by itself next time.</p>;
  }
  const label = (address: string) => (address === "USDC" ? "USDC" : (assets?.assets.find((a) => a.canonicalId === address.toLowerCase())?.underlying ?? address.slice(0, 6)));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {items.map((b) => {
          const segments = b.allocations.map((a) => ({ key: String(a.assetAddress), label: label(String(a.assetAddress)), weightBps: a.weightBps }));
          return (
            <div key={b.id} className="relative border border-line rounded-[8px] bg-canvas hover:border-line-strong transition-fast">
              <button type="button" disabled={disabled} onClick={() => onLoad(b)} className="w-full text-left p-3 flex flex-col gap-2 disabled:opacity-60">
                <span className="flex items-center gap-2 pr-7 min-w-0">
                  <span className="font-medium text-[14px] truncate">{b.name}</span>
                  <Badge tone={b.source === "ai" ? "primary" : "neutral"}>{SOURCE_LABEL[b.source]}</Badge>
                </span>
                <AllocationBar segments={segments} height={8} legend={false} />
                <span className="text-[12px] text-ink-secondary truncate">{segments.map((s) => `${s.label} ${bpsToPct(s.weightBps)}`).join(" · ")}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
                  {b.allocations.length} {b.allocations.length === 1 ? "leg" : "legs"} · {timeAgo(b.savedAt)}
                </span>
              </button>
              <button type="button" aria-label={`Remove ${b.name} from recent baskets`} onClick={() => onForget(b.id)} className="absolute top-2 right-2 h-7 w-7 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink hover:bg-surface transition-fast">
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
          );
        })}
      </div>
      <p className="text-[12px] text-ink-muted">Kept in this browser only; nothing is uploaded. Publish a basket to keep it anywhere.</p>
    </div>
  );
}

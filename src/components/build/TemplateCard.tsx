"use client";

import Link from "next/link";
import { ArrowRight, Layers } from "lucide-react";
import type { PortfolioTemplate } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { templateLiveness } from "@/lib/templates";
import { AllocationBar } from "@/components/common/AllocationBar";
import { Button } from "@/components/ui/primitives";

/**
 * A template as a card: allocation bar with labels and percentages, how much of it can be bought
 * today, and one clear action. Templates are starting points, not recommendations.
 */
export function TemplateCard({ template, assets, onLoad, compact = false }: { template: PortfolioTemplate; assets?: AssetsResponse; onLoad?: (t: PortfolioTemplate) => void; compact?: boolean }) {
  const lookup = (address: string) => assets?.assets.find((a) => a.canonicalId === address.toLowerCase());
  const segments = template.allocations.map((a) => ({ key: a.assetAddress === "USDC" ? "USDC" : a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : (lookup(a.assetAddress)?.underlying ?? a.assetAddress.slice(0, 6)), weightBps: a.weightBps }));
  const live = templateLiveness(template, assets);
  const allLive = live.total > 0 && live.live === live.total;
  const noneLive = live.live === 0;
  const readyPct = Math.round((live.tradableBps + live.cashBps) / 100);
  return (
    <article className={`border border-line rounded-[8px] bg-canvas p-4 flex flex-col gap-3 ${noneLive ? "opacity-80" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="display-medium text-[18px] leading-tight truncate">{template.name}</h3>
          {!compact && <p className="text-[13px] text-ink-secondary line-clamp-2 mt-1">{template.description.replace(/\s*A template, not a recommendation\.?$/i, "")}</p>}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-muted text-right">
          {live.total} stock{live.total === 1 ? "" : "s"}
          {live.cashBps > 0 ? ` · ${live.cashBps / 100}% cash` : ""}
        </span>
      </div>
      <AllocationBar segments={segments} height={8} />
      <div className="mt-auto flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
          <span className={allLive ? "text-positive-fg" : noneLive ? "text-ink-muted" : "text-ink-secondary"}>
            {allLive ? `All ${live.total} live` : noneLive ? "Nothing issued yet" : `${live.live} of ${live.total} live · ${readyPct}% goes to work today`}
          </span>
          <Link href={`/build/${template.slug}`} className="text-ink-secondary hover:text-ink inline-flex items-center gap-1 shrink-0">
            Details <ArrowRight size={12} strokeWidth={1.75} />
          </Link>
        </div>
        {live.notIssued.length > 0 && (
          <p className="text-[11px] text-ink-muted leading-snug">
            {`${live.notIssued.join(", ")}: not issued on Base yet — ${live.notIssuedBps / 100}% of this stays as USDC until Coinbase mints ${live.notIssued.length === 1 ? "it" : "them"}.`}
          </p>
        )}
        {live.illiquid.length > 0 && (
          <p className="text-[11px] text-ink-muted leading-snug">
            {`${live.illiquid.join(", ")}: issued, but the pool is too shallow to fill a normal leg yet.`}
          </p>
        )}
        {onLoad && (
          <Button size="sm" full variant={noneLive ? "secondary" : "primary"} onClick={() => onLoad(template)}>
            <Layers size={14} strokeWidth={1.75} />
            {noneLive ? "Use anyway" : "Use this template"}
          </Button>
        )}
      </div>
    </article>
  );
}

"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PortfolioTemplate } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { AllocationBar } from "@/components/common/AllocationBar";
import { Badge, Button } from "@/components/ui/primitives";

/**
 * A template as a card: allocation bar with labels and percentages, how much of it is tradable
 * today, and one action. Templates are starting points, not recommendations.
 */
export function TemplateCard({ template, assets, onLoad, compact = false }: { template: PortfolioTemplate; assets?: AssetsResponse; onLoad?: (t: PortfolioTemplate) => void; compact?: boolean }) {
  const lookup = (address: string) => assets?.assets.find((a) => a.canonicalId === address.toLowerCase());
  const segments = template.allocations.map((a) => ({ key: a.assetAddress === "USDC" ? "USDC" : a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : (lookup(a.assetAddress)?.underlying ?? a.assetAddress.slice(0, 6)), weightBps: a.weightBps }));
  const stocks = template.allocations.filter((a) => a.assetAddress !== "USDC");
  const cashBps = template.allocations.find((a) => a.assetAddress === "USDC")?.weightBps ?? 0;
  const live = stocks.filter((a) => BigInt(lookup(a.assetAddress)?.totalSupply ?? "0") > 0n).length;
  return (
    <article className="border border-line rounded-[8px] bg-canvas p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="display-medium text-[18px] leading-tight truncate">{template.name}</h3>
          {!compact && <p className="text-[13px] text-ink-secondary line-clamp-2 mt-1">{template.description.replace(/\s*A template, not a recommendation\.?$/i, "")}</p>}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-muted text-right">
          {stocks.length} stock{stocks.length === 1 ? "" : "s"}
          {cashBps > 0 ? ` · ${cashBps / 100}% cash` : ""}
        </span>
      </div>
      <AllocationBar segments={segments} height={8} />
      <div className="mt-auto flex items-center justify-between gap-2">
        {live < stocks.length ? <Badge tone="warning">{stocks.length - live} not issued yet</Badge> : <Badge tone="positive">all live</Badge>}
        <span className="flex items-center gap-3">
          <Link href={`/build/${template.slug}`} className="text-[12px] text-ink-secondary hover:text-ink inline-flex items-center gap-1">
            Details <ArrowRight size={12} strokeWidth={1.75} />
          </Link>
          {onLoad && (
            <Button size="sm" onClick={() => onLoad(template)}>
              Use
            </Button>
          )}
        </span>
      </div>
    </article>
  );
}

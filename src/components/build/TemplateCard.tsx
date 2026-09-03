"use client";

import Link from "next/link";
import { ArrowRight, Download } from "lucide-react";
import type { PortfolioTemplate } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { AllocationBar } from "@/components/common/AllocationBar";
import { Badge, Button } from "@/components/ui/primitives";

/**
 * A template as a card: what is in it (allocation bar with labels and percentages), how much of it
 * is tradable today, and two actions: load into the editor on this page, or open its own page.
 * Templates are starting points, not recommendations.
 */
export function TemplateCard({ template, assets, onLoad }: { template: PortfolioTemplate; assets?: AssetsResponse; onLoad?: (t: PortfolioTemplate) => void }) {
  const lookup = (address: string) => assets?.assets.find((a) => a.canonicalId === address.toLowerCase());
  const segments = template.allocations.map((a) => ({ key: a.assetAddress === "USDC" ? "USDC" : a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : (lookup(a.assetAddress)?.underlying ?? a.assetAddress.slice(0, 6)), weightBps: a.weightBps }));
  const stocks = template.allocations.filter((a) => a.assetAddress !== "USDC");
  const cashBps = template.allocations.find((a) => a.assetAddress === "USDC")?.weightBps ?? 0;
  const live = stocks.filter((a) => BigInt(lookup(a.assetAddress)?.totalSupply ?? "0") > 0n).length;
  const tags = Array.from(new Set(stocks.flatMap((a) => lookup(a.assetAddress)?.tags ?? []))).slice(0, 3);
  return (
    <article className="border border-line rounded-[8px] bg-canvas p-4 flex flex-col gap-3 min-h-[220px]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="display-medium text-[20px] leading-tight truncate">{template.name}</h3>
          <p className="text-[13px] text-ink-secondary line-clamp-2 mt-1">{template.description.replace(/\s*A template, not a recommendation\.?$/i, "")}</p>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-muted text-right">
          {stocks.length} stock{stocks.length === 1 ? "" : "s"}
          {cashBps > 0 ? ` · ${cashBps / 100}% cash` : ""}
        </span>
      </div>
      <AllocationBar segments={segments} height={10} />
      <div className="flex items-center gap-1.5 flex-wrap">
        {live < stocks.length ? <Badge tone="warning">{stocks.length - live} not issued yet · kept as USDC</Badge> : <Badge tone="positive">all live</Badge>}
        {tags.map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>
      <div className="mt-auto flex items-center gap-2">
        {onLoad && (
          <Button size="sm" variant="secondary" onClick={() => onLoad(template)}>
            <Download size={14} strokeWidth={1.75} /> Load into editor
          </Button>
        )}
        <Link href={`/build/${template.slug}`} className="text-[13px] text-primary font-medium inline-flex items-center gap-1">
          Open <ArrowRight size={14} strokeWidth={1.75} />
        </Link>
      </div>
    </article>
  );
}

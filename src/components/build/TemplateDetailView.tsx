"use client";

import Link from "next/link";
import { useState } from "react";
import type { PortfolioTemplate, Allocation } from "@/domain/portfolio";
import type { AssetsResponse } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { bpsToPct, formatUsd } from "@/lib/format";
import { AssetLogo, PriceChange } from "@/components/common/display";
import { AllocationBar, ColorDot } from "@/components/common/AllocationBar";
import { Module, ModuleHeader, Button } from "@/components/ui/primitives";
import { AllocationEditor } from "./AllocationEditor";
import { PlanExecutor } from "./PlanExecutor";

export function TemplateDetailView({ template, initialAssets }: { template: PortfolioTemplate; initialAssets?: AssetsResponse }) {
  const { data: assets } = useAssets(initialAssets);
  const [allocations, setAllocations] = useState<Allocation[]>(template.allocations);
  const [editing, setEditing] = useState(false);
  const customized = JSON.stringify(allocations) !== JSON.stringify(template.allocations);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/build" className="text-[13px] text-primary font-medium">
          ← Build
        </Link>
        <h1 className="display text-[32px] md:text-[48px] leading-none mt-2">{template.name}</h1>
        <p className="mt-2 max-w-[60ch] text-ink-secondary">{template.description}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <Module>
          <ModuleHeader title={customized ? "Customized allocation" : "Allocation"} action={<Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>{editing ? "Done" : "Customize"}</Button>} />
          {editing && assets ? (
            <div className="p-4">
              <AllocationEditor assets={assets.assets} value={allocations} onChange={setAllocations} />
            </div>
          ) : (
            <ul>
              {allocations.map((a) => {
                const asset = a.assetAddress === "USDC" ? null : assets?.assets.find((x) => x.canonicalId === a.assetAddress.toLowerCase());
                const price = asset ? assets?.prices[asset.canonicalId] : undefined;
                return (
                  <li key={a.assetAddress} className="flex items-center justify-between px-4 py-3 border-b border-line last:border-b-0 gap-3">
                    <span className="flex items-center gap-3 min-w-0">
                      <ColorDot k={a.assetAddress} />
                      {asset ? <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={32} /> : <span className="inline-flex items-center justify-center h-8 w-8 rounded-[6px] border border-line font-mono text-[11px]">USDC</span>}
                      <span className="min-w-0">
                        <span className="block font-medium text-[14px]">{asset ? asset.underlying : "USDC cash"}</span>
                        <span className="block text-[12px] text-ink-secondary truncate">{asset ? asset.name : "Held as cash"}</span>
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block display num text-[16px]">{bpsToPct(a.weightBps)}</span>
                      {asset && (
                        <span className="block text-[12px] font-mono num text-ink-secondary">
                          {formatUsd(price?.displayUsd)} <PriceChange value={price?.marketChange24hPct} />
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="px-4 py-3 border-t border-line">
            <AllocationBar height={8} segments={allocations.map((a) => ({ key: a.assetAddress, label: a.assetAddress === "USDC" ? "USDC" : (assets?.assets.find((x) => x.canonicalId === a.assetAddress.toLowerCase())?.underlying ?? "?"), weightBps: a.weightBps }))} />
          </div>
        </Module>
        <Module className="lg:sticky lg:top-[72px]">
          <ModuleHeader title="Invest in this template" />
          <div className="p-4">
            <PlanExecutor key={JSON.stringify(allocations)} allocations={allocations} source="template" />
          </div>
          <p className="px-4 pb-4 text-[12px] text-ink-muted">A template, not a recommendation. You keep custody at every step.</p>
        </Module>
      </div>
    </div>
  );
}

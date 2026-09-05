"use client";

import { AlertTriangle, Newspaper, Sparkles } from "lucide-react";
import type { DraftCommentary as Commentary } from "@/lib/client-api";
import { useAssets } from "@/hooks/queries";
import { AssetLogo } from "@/components/common/display";
import { Module, ModuleHeader, Badge } from "@/components/ui/primitives";

/**
 * The assistant's reasoning next to its draft: what the mix is built around, why each leg, what
 * could go against it, and the headlines it leaned on. Shown as commentary — the weights above are
 * the user's to change, and the note at the bottom says so.
 */
export function DraftCommentary({ commentary, stale = false }: { commentary: Commentary; stale?: boolean }) {
  const { data: assets } = useAssets();
  const infoOf = (symbol: string) => assets?.assets.find((a) => a.underlying.toUpperCase() === symbol.toUpperCase());
  const empty = !commentary.thesis && commentary.legs.length === 0 && commentary.risks.length === 0 && commentary.fromNews.length === 0;
  if (empty) return null;
  return (
    <Module>
      <ModuleHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles size={14} strokeWidth={1.75} className="text-primary" /> Why this mix
          </span>
        }
        action={stale ? <Badge tone="warning">for the draft as generated</Badge> : <Badge>commentary · not advice</Badge>}
      />
      <div className="p-4 flex flex-col gap-4">
        {commentary.thesis && <p className="text-[14px] leading-relaxed">{commentary.thesis}</p>}
        {commentary.legs.length > 0 && (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
            {commentary.legs.map((l) => {
              const info = infoOf(l.symbol);
              return (
                <li key={l.symbol} className="flex items-start gap-2.5 text-[13px]">
                  {info ? <AssetLogo src={info.logoURI} symbol={info.symbol} size={22} className="mt-0.5 shrink-0" /> : <span className="w-[22px] shrink-0" />}
                  <span className="min-w-0">
                    <span className="font-medium">{l.symbol}</span> <span className="text-ink-secondary">{l.why}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {commentary.risks.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted inline-flex items-center gap-1.5">
              <AlertTriangle size={11} strokeWidth={1.75} /> What could go against it
            </div>
            <ul className="list-disc pl-4 text-[13px] text-ink-secondary flex flex-col gap-1">
              {commentary.risks.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {commentary.fromNews.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted inline-flex items-center gap-1.5">
              <Newspaper size={11} strokeWidth={1.75} /> From the headlines
            </div>
            <ul className="list-disc pl-4 text-[13px] text-ink-secondary flex flex-col gap-1">
              {commentary.fromNews.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] text-ink-muted">Written by the assistant from the live status and liquidity of each stock, the shared market brief and recent headlines (titles only). It explains a template; it does not recommend one. Facts may lag.</p>
      </div>
    </Module>
  );
}

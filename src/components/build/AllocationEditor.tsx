"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import type { Address } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation } from "@/domain/portfolio";
import { validateAllocations } from "@/services/portfolio-service";
import { AssetLogo } from "@/components/common/display";
import { Button, cx } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Slider } from "@/components/ui/Slider";
import { ColorDot } from "@/components/common/AllocationBar";
import { assetColor } from "@/lib/colors";

interface Props {
  assets: B20AssetDTO[];
  value: Allocation[];
  onChange: (next: Allocation[]) => void;
}

/** Custom allocation editor: sliders + exact inputs, arranged as clear financial blocks (spec §4.4, §46). */
export function AllocationEditor({ assets, value, onChange }: Props) {
  const byId = useMemo(() => new Map(assets.map((a) => [a.canonicalId, a])), [assets]);
  const total = value.reduce((s, a) => s + a.weightBps, 0);
  const validation = validateAllocations(value);
  const used = new Set(value.map(keyOf));
  const available = assets.filter((a) => a.status === "active" && !used.has(a.canonicalId));
  const hasUsdc = used.has(USDC_ALLOCATION_KEY);
  const remaining = Math.max(0, TOTAL_BPS - total);

  const setWeight = (key: string, bps: number) => {
    const clamped = Math.max(0, Math.min(TOTAL_BPS, Math.round(bps)));
    onChange(value.map((a) => (keyOf(a) === key ? { ...a, weightBps: clamped } : a)));
  };
  const remove = (key: string) => onChange(value.filter((a) => keyOf(a) !== key));
  const add = (target: string) => {
    if (!target) return;
    onChange([...value, { assetAddress: target === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : (target as Address), weightBps: remaining }]);
  };
  const equalize = () => {
    if (value.length === 0) return;
    const per = Math.floor(TOTAL_BPS / value.length);
    const rem = TOTAL_BPS - per * value.length;
    onChange(value.map((a, i) => ({ ...a, weightBps: per + (i === 0 ? rem : 0) })));
  };
  const normalize = () => {
    if (total === 0 || value.length === 0) return;
    const scaled = value.map((a) => ({ ...a, weightBps: Math.max(1, Math.round((a.weightBps / total) * TOTAL_BPS)) }));
    const diff = TOTAL_BPS - scaled.reduce((s, a) => s + a.weightBps, 0);
    const idx = scaled.reduce((best, a, i) => (a.weightBps > scaled[best]!.weightBps ? i : best), 0);
    scaled[idx]!.weightBps += diff;
    onChange(scaled);
  };

  const options = [
    ...[...available].sort((a, b) => Number(BigInt(a.totalSupply ?? "0") === 0n) - Number(BigInt(b.totalSupply ?? "0") === 0n)).map((a) => ({ value: a.address as string, label: `${a.underlying} — ${a.name}`, description: BigInt(a.totalSupply ?? "0") === 0n ? "not issued yet · cannot be bought until Coinbase mints it" : a.tags.join(" · ") })),
    ...(hasUsdc ? [] : [{ value: USDC_ALLOCATION_KEY as string, label: "USDC cash", description: "Kept as cash for later buys" }]),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-line rounded-[8px] overflow-hidden bg-canvas">
        {value.length === 0 && <p className="px-4 py-5 text-[14px] text-ink-secondary">Add stocks to start. Drag the sliders or type exact weights; the total must be 100%.</p>}
        {value.map((a, i) => {
          const key = keyOf(a);
          const asset = a.assetAddress === USDC_ALLOCATION_KEY ? null : byId.get(a.assetAddress.toLowerCase());
          return (
            <div key={key} className="grid grid-cols-[1fr_44px] md:grid-cols-[220px_1fr_112px_44px] items-center gap-3 px-3 py-3 border-b border-line last:border-b-0">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-[11px] text-ink-muted w-5">{String(i + 1).padStart(2, "0")}</span>
                <ColorDot k={key} />
                {asset ? <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={32} /> : <span className="inline-flex items-center justify-center h-8 w-8 rounded-[6px] border border-line font-mono text-[10px]">USDC</span>}
                <div className="min-w-0">
                  <div className="font-medium text-[14px] truncate">{asset ? asset.underlying : "USDC cash"}</div>
                  <div className="text-[12px] text-ink-secondary truncate">{asset ? asset.name : "Kept as cash"}</div>
                </div>
              </div>
              <div className="md:hidden row-start-2 col-span-2">
                <Slider value={a.weightBps / 100} min={0} max={100} step={0.5} onChange={(v) => setWeight(key, v * 100)} ariaLabel={`Weight for ${asset ? asset.underlying : "USDC"}`} valueLabel={`${(a.weightBps / 100).toFixed(1)}%`} />
              </div>
              <div className="hidden md:block">
                <Slider value={a.weightBps / 100} min={0} max={100} step={0.5} onChange={(v) => setWeight(key, v * 100)} ariaLabel={`Weight for ${asset ? asset.underlying : "USDC"}`} />
              </div>
              <label className="hidden md:flex items-center h-11 rounded-[6px] border border-line-strong focus-within:border-primary px-2 gap-1">
                <span className="sr-only">Exact weight percent for {asset ? asset.underlying : "USDC"}</span>
                <input inputMode="decimal" value={(a.weightBps / 100).toString()} onChange={(e) => setWeight(key, Number(e.target.value.replace(/[^0-9.]/g, "") || 0) * 100)} className="w-full bg-transparent outline-none text-right num text-[15px]" />
                <span className="text-[12px] text-ink-muted font-mono">%</span>
              </label>
              <button type="button" aria-label={`Remove ${asset ? asset.underlying : "USDC"}`} onClick={() => remove(key)} className="h-11 w-11 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-danger-fg">
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Select value="" onChange={add} options={options} placeholder={options.length ? "Add a stock or USDC cash…" : "All stocks added"} ariaLabel="Add asset" className="flex-1" disabled={options.length === 0} />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={equalize} disabled={value.length === 0}>
            Equal weights
          </Button>
          <Button variant="secondary" size="sm" onClick={normalize} disabled={value.length === 0 || total === TOTAL_BPS || total === 0}>
            Scale to 100%
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between eyebrow">
          <span>Total</span>
          <span className={cx("font-mono", total === TOTAL_BPS ? "text-positive-fg" : "text-danger-fg")}>
            {(total / 100).toFixed(1)}% / 100%{remaining > 0 && ` · ${(remaining / 100).toFixed(1)}% left`}
          </span>
        </div>
        <div className="h-2.5 rounded-full bg-surface-muted overflow-hidden flex gap-px" aria-hidden>
          {value.map((a) => (
            <div key={keyOf(a)} className="h-full transition-base" style={{ width: `${Math.min(100, (a.weightBps / TOTAL_BPS) * 100)}%`, background: assetColor(keyOf(a)) }} />
          ))}
        </div>
        {!validation.ok && value.length > 0 && (
          <ul className="text-[13px] text-danger-fg">
            {validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function keyOf(a: Allocation): string {
  return a.assetAddress === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : a.assetAddress.toLowerCase();
}

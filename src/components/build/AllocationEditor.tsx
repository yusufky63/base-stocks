"use client";

import { useMemo, useState } from "react";
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
import { referenceGap, referenceGapNote, tradingStatus } from "@/lib/trading-status";
import { useAssets } from "@/hooks/queries";

interface Props {
  assets: B20AssetDTO[];
  value: Allocation[];
  onChange: (next: Allocation[]) => void;
  /** Locked while a plan built from this basket is executing: a moving slider mid-run is a lie about what is being bought. */
  disabled?: boolean;
}

/** Custom allocation editor: sliders + exact inputs, arranged as clear financial blocks (spec §4.4, §46). */
export function AllocationEditor({ assets, value, onChange, disabled = false }: Props) {
  // Already in the query cache from the page above; this is a read, not another request.
  const prices = useAssets().data?.prices;
  const byId = useMemo(() => new Map(assets.map((a) => [a.canonicalId, a])), [assets]);
  const total = value.reduce((s, a) => s + a.weightBps, 0);
  const validation = validateAllocations(value);
  const used = new Set(value.map(keyOf));
  const available = assets.filter((a) => a.status === "active" && !used.has(a.canonicalId));
  const hasUsdc = used.has(USDC_ALLOCATION_KEY);
  const remaining = Math.max(0, TOTAL_BPS - total);

  const setWeight = (key: string, bps: number) => {
    if (disabled) return;
    const clamped = Math.max(0, Math.min(TOTAL_BPS, Math.round(bps)));
    onChange(value.map((a) => (keyOf(a) === key ? { ...a, weightBps: clamped } : a)));
  };
  const remove = (key: string) => !disabled && onChange(value.filter((a) => keyOf(a) !== key));
  const add = (target: string) => {
    if (!target || disabled) return;
    const next: Allocation = { assetAddress: target === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : (target as Address), weightBps: remaining };
    if (remaining > 0) return onChange([...value, next]);
    // Basket already at 100%: take an equal share from the largest slice so the new asset never starts at 0%.
    const share = Math.floor(TOTAL_BPS / (value.length + 1));
    const idx = value.reduce((best, a, i) => (a.weightBps > value[best]!.weightBps ? i : best), 0);
    const largest = value[idx]!;
    const taken = Math.min(share, Math.max(0, largest.weightBps - 1));
    if (taken <= 0) return onChange([...value, { ...next, weightBps: 1 }]);
    onChange([...value.map((a, i) => (i === idx ? { ...a, weightBps: a.weightBps - taken } : a)), { ...next, weightBps: taken }]);
  };
  const equalize = () => {
    if (value.length === 0 || disabled) return;
    const per = Math.floor(TOTAL_BPS / value.length);
    const rem = TOTAL_BPS - per * value.length;
    onChange(value.map((a, i) => ({ ...a, weightBps: per + (i === 0 ? rem : 0) })));
  };
  const normalize = () => {
    if (total === 0 || value.length === 0 || disabled) return;
    const scaled = value.map((a) => ({ ...a, weightBps: Math.max(1, Math.round((a.weightBps / total) * TOTAL_BPS)) }));
    const diff = TOTAL_BPS - scaled.reduce((s, a) => s + a.weightBps, 0);
    const idx = scaled.reduce((best, a, i) => (a.weightBps > scaled[best]!.weightBps ? i : best), 0);
    scaled[idx]!.weightBps += diff;
    onChange(scaled);
  };

  // What the picker offers is decided by the same status the Markets page shows, not by a raw
  // supply check: a stock with supply and no pool is just as unbuyable as one with no supply, and
  // a $108 pool will fill a basket leg at a price nobody meant to accept.
  const statusOf = (a: B20AssetDTO) => tradingStatus(a, prices?.[a.canonicalId]).status;
  const rank: Record<string, number> = { tradable: 0, thin: 1, "very-thin": 2, "no-pool": 3, "not-issued": 4, paused: 5 };
  const describe = (a: B20AssetDTO) => {
    switch (statusOf(a)) {
      case "not-issued":
        return "not issued yet · cannot be bought until Coinbase mints it";
      case "no-pool":
        return "issued, but no DEX pool yet · nothing can fill this leg";
      case "very-thin":
        return "very thin pool · a normal leg would move the price sharply";
      case "thin":
        return `thin pool · ${a.tags.join(" · ")}`;
      case "paused":
        return "transfers paused by the issuer";
      default:
        return a.tags.join(" · ");
    }
  };
  const unbuyable = (a: B20AssetDTO) => ["not-issued", "no-pool", "paused"].includes(statusOf(a));

  const options = [
    ...[...available]
      .sort((a, b) => (rank[statusOf(a)] ?? 9) - (rank[statusOf(b)] ?? 9))
      .map((a) => ({ value: a.address as string, label: `${a.underlying} — ${a.name}`, description: describe(a), disabled: unbuyable(a) })),
    ...(hasUsdc ? [] : [{ value: USDC_ALLOCATION_KEY as string, label: "USDC cash", description: "Kept as cash for later buys" }]),
  ];
  const empty = value.length === 0;

  return (
    <div className={cx("flex flex-col gap-4", disabled && "opacity-70 pointer-events-none select-none")} aria-disabled={disabled}>
      <div className="border border-line rounded-[8px] overflow-hidden bg-canvas">
        {empty && <p className="px-4 py-5 text-[14px] text-ink-secondary">Add stocks to start. Drag the sliders or type exact weights; the total must be 100%.</p>}
        {value.map((a, i) => {
          const key = keyOf(a);
          const asset = a.assetAddress === USDC_ALLOCATION_KEY ? null : byId.get(a.assetAddress.toLowerCase());
          const rowStatus = asset ? tradingStatus(asset, prices?.[asset.canonicalId]).status : null;
          const blocked = rowStatus === "not-issued" || rowStatus === "no-pool" || rowStatus === "paused";
          // A pool far above its Chainlink reference sells the stock at a premium; a basket is reviewed
          // once, so the row says it where the Trade page would.
          const gap = asset ? referenceGap(prices?.[asset.canonicalId]) : null;
          const gapNote = asset ? referenceGapNote(prices?.[asset.canonicalId]) : null;
          const rowNote =
            rowStatus === "not-issued"
              ? "Kept as USDC until Coinbase mints it"
              : rowStatus === "no-pool"
                ? "Issued, but no pool can fill this leg yet"
                : rowStatus === "very-thin"
                  ? "Pool is very thin — expect a poor fill"
                  : rowStatus === "paused"
                    ? "Transfers paused by the issuer"
                    : null;
          const rowTag = rowStatus === "not-issued" ? "not issued" : rowStatus === "no-pool" ? "no pool" : rowStatus === "very-thin" ? "very thin" : rowStatus === "paused" ? "paused" : gap && gap.pct >= 15 ? "premium" : null;
          const label = asset ? asset.underlying : "USDC";
          return (
            <div key={key} className={cx("grid grid-cols-[1fr_44px] md:grid-cols-[220px_1fr_112px_44px] items-center gap-3 px-3 py-3 border-b border-line last:border-b-0", blocked && "opacity-70")}>
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-[11px] text-ink-muted w-5">{String(i + 1).padStart(2, "0")}</span>
                <ColorDot k={key} />
                {asset ? <AssetLogo src={asset.logoURI} symbol={asset.symbol} size={32} /> : <span className="inline-flex items-center justify-center h-8 w-8 rounded-[6px] border border-line font-mono text-[10px]">USDC</span>}
                <div className="min-w-0">
                  <div className="font-medium text-[14px] truncate">
                    {asset ? asset.underlying : "USDC cash"}
                    {rowTag && <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-warning-fg">{rowTag}</span>}
                  </div>
                  <div className="text-[12px] text-ink-secondary truncate" title={gapNote ?? undefined}>{asset ? (rowNote ?? (gapNote ? `${gapNote[0]!.toUpperCase()}${gapNote.slice(1)}` : asset.name)) : "Kept as cash"}</div>
                </div>
              </div>
              <div className="md:hidden row-start-2 col-span-2">
                <Slider value={a.weightBps / 100} min={0} max={100} step={0.5} disabled={disabled} onChange={(v) => setWeight(key, v * 100)} ariaLabel={`Weight for ${label}`} valueLabel={`${(a.weightBps / 100).toFixed(1)}%`} />
              </div>
              <div className="hidden md:block">
                <Slider value={a.weightBps / 100} min={0} max={100} step={0.5} disabled={disabled} onChange={(v) => setWeight(key, v * 100)} ariaLabel={`Weight for ${label}`} />
              </div>
              <WeightInput label={label} bps={a.weightBps} disabled={disabled} onCommit={(bps) => setWeight(key, bps)} />
              <button type="button" aria-label={`Remove ${label}`} disabled={disabled} onClick={() => remove(key)} className="h-11 w-11 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-danger-fg disabled:opacity-40">
                <X size={16} strokeWidth={1.75} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Select value="" onChange={add} options={options} placeholder={options.length ? "Add a stock or USDC cash…" : "All stocks added"} ariaLabel="Add asset" className="flex-1" disabled={options.length === 0 || disabled} />
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={equalize} disabled={empty || disabled}>
            Equal weights
          </Button>
          <Button variant="secondary" size="sm" onClick={normalize} disabled={empty || total === TOTAL_BPS || total === 0 || disabled}>
            Scale to 100%
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between eyebrow">
          <span>Total</span>
          {/* An empty basket is a blank page, not a mistake: the red only appears once there is a number to be wrong. */}
          <span className={cx("font-mono", empty ? "text-ink-muted" : total === TOTAL_BPS ? "text-positive-fg" : "text-danger-fg")}>
            {(total / 100).toFixed(1)}% / 100%{!empty && remaining > 0 && ` · ${(remaining / 100).toFixed(1)}% left`}
          </span>
        </div>
        <div className="h-2.5 rounded-full bg-surface-muted overflow-hidden flex gap-px" aria-hidden>
          {value.map((a) => (
            <div key={keyOf(a)} className="h-full transition-base" style={{ width: `${Math.min(100, (a.weightBps / TOTAL_BPS) * 100)}%`, background: assetColor(keyOf(a)) }} />
          ))}
        </div>
        {!validation.ok && !empty && (
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

/**
 * The exact-weight box keeps its own text while it is being typed in. A controlled input that
 * normalised on every keystroke lost the decimal point: "7", ".", "5" came out as 75%. Here "7.5"
 * is committed as 750 bps the moment it parses, and the box only snaps to the canonical form on blur.
 */
function WeightInput({ label, bps, disabled, onCommit }: { label: string; bps: number; disabled?: boolean; onCommit: (bps: number) => void }) {
  const canonical = (bps / 100).toString();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? canonical;
  return (
    <label className="hidden md:flex items-center h-11 rounded-[6px] border border-line-strong focus-within:border-primary px-2 gap-1">
      <span className="sr-only">Exact weight percent for {label}</span>
      <input
        inputMode="decimal"
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, "");
          if ((raw.match(/\./g) ?? []).length > 1) return;
          setDraft(raw);
          const parsed = parseWeightPercent(raw);
          if (parsed !== null) onCommit(parsed);
        }}
        onBlur={() => setDraft(null)}
        className="w-full bg-transparent outline-none text-right num text-[15px]"
      />
      <span className="text-[12px] text-ink-muted font-mono">%</span>
    </label>
  );
}

/** "7.5" → 750; "" or "." → 0; anything else that is not a number → null (leave the weight alone). */
export function parseWeightPercent(raw: string): number | null {
  if (raw === "" || raw === ".") return 0;
  if (!/^\d*\.?\d*$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(TOTAL_BPS, Math.round(n * 100)));
}

export function keyOf(a: Allocation): string {
  return a.assetAddress === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : a.assetAddress.toLowerCase();
}

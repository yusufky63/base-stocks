"use client";

import { Check, RotateCcw } from "lucide-react";
import { formatUnits } from "viem";
import type { B20AssetDTO } from "@/domain/asset";
import type { TradeProviderId, TradeQuoteAlternative, TradeSide } from "@/domain/trade";
import { USDC_DECIMALS } from "@/config/chain";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { IntegrationMark } from "@/components/common/IntegrationMark";

export const PROVIDER_LABEL: Record<TradeProviderId, string> = { zeroX: "0x", kyber: "KyberSwap", okx: "OKX", uniswap: "Uniswap", velora: "Velora", aerodrome: "Aerodrome direct", cow: "CoW Protocol · gasless" };

/** Marks for the comparison rows and the route line (DefiLlama icon CDN slugs, lettered fallback). */
const PROVIDER_MARK: Record<TradeProviderId, { name: string; mark: string | null; color: string }> = {
  zeroX: { name: "0x", mark: "0x", color: "#111111" },
  kyber: { name: "KyberSwap", mark: "kyberswap", color: "#31cb9e" },
  okx: { name: "OKX", mark: "okx-dex", color: "#000000" },
  uniswap: { name: "Uniswap", mark: "uniswap", color: "#ff007a" },
  velora: { name: "Velora", mark: "velora", color: "#1a56db" },
  aerodrome: { name: "Aerodrome", mark: "aerodrome", color: "#2563eb" },
  cow: { name: "CoW Protocol", mark: "cowswap", color: "#012f7a" },
};

export function ProviderMark({ provider, size = 16, className }: { provider: TradeProviderId; size?: number; className?: string }) {
  const m = PROVIDER_MARK[provider];
  if (!m) return null;
  return <IntegrationMark name={m.name} mark={m.mark} color={m.color} size={size} className={className} />;
}

/** Short, honest reason when a provider returned nothing. */
export function failureLabel(a: TradeQuoteAlternative): string {
  const e = a.error ?? "";
  if (a.provider === "zeroX" && /not authorized|not enabled/i.test(e)) return "opt-in pending";
  if (a.provider === "okx" && /no access|50125|entitle/i.test(e)) return "key not entitled";
  if (a.provider === "cow" && /native ETH/i.test(e)) return "USDC only";
  if (/timeout|timed out/i.test(e)) return "timed out";
  if (/liquidity|no route|route not found/i.test(e)) return "no route";
  if (/rate|429/i.test(e)) return "rate limited";
  return "no quote";
}

interface Props {
  alternatives: TradeQuoteAlternative[];
  side: TradeSide;
  asset: Pick<B20AssetDTO, "decimals" | "underlying">;
  /** null = automatic (best net output). */
  selected: TradeProviderId | null;
  onSelect: (provider: TradeProviderId | null) => void;
  loading?: boolean;
}

/**
 * Provider comparison as a picker: every provider that answered is a radio row with a bar scaled
 * to the best net output, the difference to the best in percent, and its latency. The default
 * stays automatic (best net); a manual choice is used for the firm quote without fallback.
 */
export function RouteCompare({ alternatives, side, asset, selected, onSelect, loading = false }: Props) {
  const quoted = alternatives.filter((a) => a.buyAmount && a.netUsd !== null);
  const failed = alternatives.filter((a) => !a.buyAmount || a.netUsd === null);
  const best = quoted.find((a) => a.best) ?? quoted[0];
  const bestNet = best?.netUsd ?? 0;
  const effective = selected && quoted.some((a) => a.provider === selected) ? selected : null;

  const amount = (a: TradeQuoteAlternative) => (side === "buy" ? `${formatTokenAmount(a.buyAmount, asset.decimals)} ${asset.underlying}` : formatUsd(Number(formatUnits(BigInt(a.buyAmount ?? "0"), USDC_DECIMALS))));
  const delta = (a: TradeQuoteAlternative) => {
    if (a.best || bestNet <= 0 || a.netUsd === null) return null;
    return (a.netUsd / bestNet - 1) * 100;
  };

  return (
    <div className={cx("border border-line rounded-[8px] overflow-hidden", loading && "opacity-60 transition-fast")} role="radiogroup" aria-label="Trade route">
      <div className="flex items-center justify-between gap-2 px-3 h-9 border-b border-line bg-surface">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Route · {effective ? "manual" : "auto · best net"} · {quoted.length} of {alternatives.length} quoted
        </span>
        {effective && (
          <button type="button" onClick={() => onSelect(null)} className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
            <RotateCcw size={11} strokeWidth={2} /> Use best
          </button>
        )}
      </div>
      <ul className="flex flex-col">
        {quoted.map((a) => {
          const active = effective ? a.provider === effective : a.best;
          const d = delta(a);
          const width = bestNet > 0 && a.netUsd !== null ? Math.max(6, Math.min(100, (a.netUsd / bestNet) * 100)) : 6;
          return (
            <li key={a.provider} className="border-b border-line last:border-b-0">
              <button
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelect(a.best ? null : a.provider)}
                className={cx("w-full text-left px-3 py-2 flex items-center gap-3 transition-fast hover:bg-surface", active && "bg-primary-soft/60")}
              >
                <span className={cx("shrink-0 w-4 h-4 rounded-full border inline-flex items-center justify-center", active ? "border-primary bg-primary text-primary-contrast" : "border-line-strong")} aria-hidden>
                  {active && <Check size={11} strokeWidth={3} />}
                </span>
                <ProviderMark provider={a.provider} size={20} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cx("text-[13px] font-medium truncate", active ? "text-ink" : "text-ink-secondary")}>
                      {PROVIDER_LABEL[a.provider] ?? a.provider}
                      {a.best && <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-primary">best</span>}
                    </span>
                    <span className="font-mono num text-[12px] text-ink shrink-0">{amount(a)}</span>
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <span className="flex-1 h-1 rounded-full bg-surface-muted overflow-hidden" aria-hidden>
                      <span className={cx("block h-full rounded-full transition-[width] duration-300", a.best ? "bg-primary" : "bg-ink-muted/60")} style={{ width: `${width}%` }} />
                    </span>
                    <span className={cx("font-mono num text-[10px] shrink-0 w-[60px] text-right", d === null ? "text-primary" : d > -0.005 ? "text-ink-muted" : d > -0.5 ? "text-ink-secondary" : "text-warning-fg")}>
                      {d === null ? "best" : d > -0.005 ? "≈ same" : `${d.toFixed(2)}%`}
                    </span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-ink-muted truncate">
                    {a.route || "direct"} · {a.latencyMs} ms{a.netUsd !== null ? ` · net ≈ ${formatUsd(a.netUsd)}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {failed.length > 0 && (
          <li className="px-3 py-2 flex flex-wrap gap-x-3 gap-y-1 bg-surface/60">
            {failed.map((a) => (
              <span key={a.provider} className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted" title={a.error}>
                <ProviderMark provider={a.provider} size={12} className="opacity-70" />
                {PROVIDER_LABEL[a.provider] ?? a.provider}: {failureLabel(a)}
              </span>
            ))}
          </li>
        )}
      </ul>
      <p className="px-3 py-2 text-[11px] text-ink-muted border-t border-line">Net = output at the current price minus the estimated network fee. Auto asks the best provider for the firm quote and falls back if it fails; a manual choice is used as-is.</p>
    </div>
  );
}

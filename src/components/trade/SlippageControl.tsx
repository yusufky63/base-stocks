"use client";

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useSlippage } from "@/hooks/useSettings";
import { Chip, cx } from "@/components/ui/primitives";

const PRESETS_BPS = [10, 50, 100, 200, 300];

/**
 * Slippage tolerance next to the trade: a compact pill showing the current value, with a
 * popover of presets and a custom field. Same store as Settings, so both stay in sync.
 */
export function SlippageControl({ className }: { className?: string }) {
  const { slippageBps, setSlippageBps } = useSlippage();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pct = (slippageBps / 100).toFixed(slippageBps % 100 === 0 ? 0 : slippageBps % 10 === 0 ? 1 : 2);
  const high = slippageBps >= 300;

  return (
    <div ref={ref} className={cx("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Slippage tolerance"
        className={cx("inline-flex items-center gap-1.5 h-9 px-2.5 rounded-[6px] border text-[12px] font-mono num transition-fast", open ? "border-primary text-primary" : high ? "border-warning-fg/60 text-warning-fg" : "border-line text-ink-secondary hover:border-line-strong hover:text-ink")}
      >
        <SlidersHorizontal size={13} strokeWidth={1.75} /> {pct}%
      </button>
      {open && (
        <div role="dialog" aria-label="Slippage tolerance" className="absolute right-0 top-[calc(100%+6px)] z-30 w-[260px] rounded-[8px] border border-line bg-canvas shadow-[0_8px_24px_rgba(0,0,0,0.12)] p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Slippage tolerance</span>
            <span className="font-mono num text-[12px] text-ink">{pct}%</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS_BPS.map((b) => (
              <Chip key={b} active={slippageBps === b} onClick={() => { setSlippageBps(b); setCustom(""); }} className="h-8 min-h-[32px] px-2.5 text-[12px]">
                {(b / 100).toFixed(b % 100 === 0 ? 0 : 1)}%
              </Chip>
            ))}
            <label className={cx("flex items-center h-8 rounded-[6px] border px-2 gap-1 text-[12px] transition-fast focus-within:border-primary", PRESETS_BPS.includes(slippageBps) ? "border-line text-ink-secondary" : "border-primary text-ink")}>
              <input
                inputMode="decimal"
                placeholder="Custom"
                aria-label="Custom slippage percent"
                value={custom !== "" ? custom : PRESETS_BPS.includes(slippageBps) ? "" : pct}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, "");
                  setCustom(v);
                  const n = Number(v);
                  if (v !== "" && Number.isFinite(n)) setSlippageBps(Math.round(n * 100));
                }}
                className="w-14 bg-transparent outline-none num placeholder:text-ink-muted"
              />
              <span>%</span>
            </label>
          </div>
          <p className="text-[11px] text-ink-muted leading-snug">
            The most the executable price may move against you between quote and settlement. {high ? "3% or more leaves room for a worse fill; use it only for thin markets." : "1% suits the current B20 pools; 0.1–0.5% may fail on thin markets."} Saved in Settings.
          </p>
        </div>
      )}
    </div>
  );
}

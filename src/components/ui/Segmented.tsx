"use client";

import type { ReactNode } from "react";
import { cx } from "./primitives";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  /** Text colour when active; "buy"/"sell" map to the brand's positive and danger inks. */
  tone?: "default" | "buy" | "sell";
  title?: string;
}

interface Props<T extends string | number> {
  options: Array<SegmentedOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Segmented control: one track, one sliding thumb (200 ms, none under reduced motion). Used for
 * Buy / Sell and for the balance-percentage presets, so a choice reads as a position, not as
 * separate buttons.
 */
export function Segmented<T extends string | number>({ options, value, onChange, ariaLabel, size = "md", className }: Props<T>) {
  const idx = options.findIndex((o) => o.value === value);
  const n = options.length;
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx("relative grid p-1 rounded-[8px] bg-surface-muted", className)} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {idx >= 0 && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 left-1 rounded-[6px] bg-canvas border border-line shadow-[0_1px_0_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ width: `calc((100% - 0.5rem) / ${n})`, transform: `translateX(${idx * 100}%)` }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative z-10 rounded-[6px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed",
              size === "md" ? "h-10 text-[13px] font-mono uppercase tracking-[0.12em]" : "h-8 text-[12px] num",
              active ? (o.tone === "sell" ? "text-danger-fg" : o.tone === "buy" ? "text-primary" : "text-ink") : "text-ink-secondary hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

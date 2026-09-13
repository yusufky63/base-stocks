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
 *
 * Exposed as a radio group, which is what it is: one value chosen from a few. It used to say
 * tablist, and a screen reader then looked for tab panels that do not exist. Arrow keys move the
 * choice the way they do between radios.
 */
export function Segmented<T extends string | number>({ options, value, onChange, ariaLabel, size = "md", className }: Props<T>) {
  const idx = options.findIndex((o) => o.value === value);
  const n = options.length;
  const step = (from: number, delta: number) => {
    for (let k = 1; k <= n; k++) {
      const o = options[(from + delta * k + n * k) % n];
      if (o && !o.disabled) return onChange(o.value);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      step(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      step(i, -1);
    }
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx("relative grid p-1 rounded-[8px] bg-surface-muted", className)} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {idx >= 0 && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 left-1 rounded-[6px] bg-canvas border border-line shadow-[0_1px_0_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ width: `calc((100% - 0.5rem) / ${n})`, transform: `translateX(${idx * 100}%)` }}
        />
      )}
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (idx < 0 && i === 0) ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
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

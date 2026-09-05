"use client";

import type { ReactNode } from "react";
import { cx } from "./primitives";

export interface OptionTile<T extends string | number> {
  value: T;
  label: ReactNode;
  /** One short line under the label: what picking this means. */
  hint?: ReactNode;
  disabled?: boolean;
}

interface Props<T extends string | number> {
  options: Array<OptionTile<T>>;
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Tailwind grid-cols classes; tiles wrap instead of squeezing, so five choices still read on a phone. */
  columns?: string;
  /** Clicking the active tile clears the choice. */
  clearable?: boolean;
  className?: string;
}

/**
 * Equal-width choice tiles that wrap. Where a segmented control is one row of short words, this
 * is for choices that need a label and a line of explanation — a theme, a risk profile — and for
 * sets too long for one row on a phone.
 */
export function OptionTiles<T extends string | number>({ options, value, onChange, ariaLabel, columns = "grid-cols-2 sm:grid-cols-3 md:grid-cols-5", clearable = false, className }: Props<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx("grid gap-1.5", columns, className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            onClick={() => onChange(clearable && active ? (null as unknown as T) : o.value)}
            className={cx(
              "text-left rounded-[6px] border px-3 py-2 min-h-[44px] flex flex-col justify-center gap-0.5 transition-fast disabled:opacity-40 disabled:cursor-not-allowed",
              active ? "border-primary bg-primary-soft text-primary" : "border-line text-ink hover:border-line-strong",
            )}
          >
            <span className="text-[13px] font-medium leading-tight">{o.label}</span>
            {o.hint && <span className={cx("text-[11px] leading-snug", active ? "text-primary/80" : "text-ink-muted")}>{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

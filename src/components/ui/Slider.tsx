"use client";

import { cx } from "./primitives";

interface Props {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  /** Optional tick labels rendered under the track (e.g. ["0%", "50%", "100%"]). */
  marks?: string[];
  /** Live value label rendered at the right. */
  valueLabel?: string;
}

/** Native range input with a Base Blue fill; keyboard and touch friendly, 44px hit area. */
export function Slider({ value, min = 0, max = 100, step = 1, onChange, ariaLabel, disabled, className, marks, valueLabel }: Props) {
  const pct = max === min ? 0 : ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          className="slider flex-1"
          style={{ "--fill": `${pct}%` } as React.CSSProperties}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-valuetext={valueLabel}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {valueLabel !== undefined && <span className="font-mono num text-[12px] text-ink-secondary min-w-[52px] text-right">{valueLabel}</span>}
      </div>
      {marks && (
        <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted px-0.5" aria-hidden>
          {marks.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

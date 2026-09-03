"use client";

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./primitives";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, prefix, suffix, className, id, ...rest }, ref) {
  const inputId = id ?? (typeof label === "string" ? `in-${label.replace(/\s+/g, "-").toLowerCase()}` : undefined);
  return (
    <label className="block" htmlFor={inputId}>
      {label && <span className="block mb-1.5 text-[12px] font-mono uppercase tracking-[0.08em] text-ink-muted">{label}</span>}
      <span className={cx("flex items-center h-12 rounded-[6px] border bg-canvas px-3 gap-2 transition-fast focus-within:border-primary", error ? "border-danger" : "border-line-strong", className)}>
        {prefix && <span className="text-ink-secondary shrink-0">{prefix}</span>}
        <input ref={ref} id={inputId} className="flex-1 min-w-0 bg-transparent outline-none text-[16px] num placeholder:text-ink-muted" {...rest} />
        {suffix && <span className="text-ink-secondary shrink-0 text-[13px] font-mono">{suffix}</span>}
      </span>
      {error ? <span className="block mt-1.5 text-[13px] text-danger-fg">{error}</span> : hint ? <span className="block mt-1.5 text-[13px] text-ink-muted">{hint}</span> : null}
    </label>
  );
});

/** Large amount input used by the trade sheet: amount first, everything else second. */
export function AmountInput({ value, onChange, unit, ariaLabel, autoFocus }: { value: string; onChange: (v: string) => void; unit: string; ariaLabel: string; autoFocus?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line-strong focus-within:border-primary pb-2 transition-fast">
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder="0"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, "");
          if ((v.match(/\./g) ?? []).length > 1) return;
          onChange(v);
        }}
        className="display num flex-1 min-w-0 bg-transparent outline-none text-[40px] md:text-[48px] leading-none placeholder:text-ink-muted"
      />
      <span className="font-mono text-[14px] text-ink-secondary shrink-0">{unit}</span>
    </div>
  );
}

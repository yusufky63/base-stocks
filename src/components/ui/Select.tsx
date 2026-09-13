"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "./primitives";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

interface Props<T extends string> {
  value: T | "";
  onChange: (value: T) => void;
  options: Array<SelectOption<T>>;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}

/**
 * Custom select (button + listbox): keyboard navigable, ARIA-labelled, styled like every other
 * module (1px borders, Base Blue selection). Replaces native <select> project-wide.
 */
export function Select<T extends string>({ value, onChange, options, placeholder = "Select…", ariaLabel, className, size = "md", disabled }: Props<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number>(-1);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const move = (delta: number) => {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const cur = enabled.indexOf(active);
    const next = enabled[(cur + delta + enabled.length) % enabled.length]!;
    setActive(next);
  };

  const commit = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      move(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) setOpen(true);
      else commit(active);
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Home") {
      setActive(0);
    } else if (e.key === "End") {
      setActive(options.length - 1);
    }
  };

  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-opt-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, options.findIndex((o) => o.value === value)));
        }}
        onKeyDown={onKeyDown}
        className={cx(
          "w-full flex items-center justify-between gap-2 rounded-[6px] border bg-canvas text-left transition-fast",
          size === "sm" ? "h-9 px-2.5 text-[13px]" : "h-11 px-3 text-[14px]",
          open ? "border-primary" : "border-line-strong hover:border-line-strong",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        <span className={cx("truncate", !selected && "text-ink-muted")}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={16} strokeWidth={1.75} className={cx("shrink-0 text-ink-muted transition-fast transition-transform", open && "rotate-180 text-primary")} />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-40 mt-1 w-full max-h-[280px] overflow-y-auto rounded-[8px] border border-line bg-canvas p-1 anim-fade shadow-[0_16px_40px_rgba(10,11,13,0.18)]"
        >
          {options.map((o, i) => {
            const isSel = o.value === value;
            const isAct = i === active;
            return (
              <li
                key={o.value}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={isSel}
                aria-disabled={o.disabled}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(i)}
                className={cx(
                  "flex items-center justify-between gap-3 rounded-[6px] px-3 py-2 text-[14px] cursor-pointer",
                  isAct && "bg-primary-soft",
                  isSel && "text-primary",
                  o.disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.description && <span className="block text-[12px] text-ink-secondary truncate">{o.description}</span>}
                </span>
                {isSel && <Check size={14} strokeWidth={2} className="shrink-0" />}
              </li>
            );
          })}
          {options.length === 0 && <li className="px-3 py-2 text-[13px] text-ink-muted">No options</li>}
        </ul>
      )}
    </div>
  );
}

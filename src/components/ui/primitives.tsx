"use client";

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import Link from "next/link";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Button ---------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "ink";
type Size = "sm" | "md" | "lg";

/**
 * Button language: honest 1px outline plus a solid 3px "ground" edge below (restrained
 * neo-brutalist step); pressing collapses the edge and the button sits down 2px.
 */
const variantClass: Record<Variant, string> = {
  primary: "bg-primary text-primary-contrast border border-primary-strong border-b-[3px] border-b-black/30 hover:bg-primary-strong active:border-b active:translate-y-[2px] disabled:opacity-40 disabled:hover:bg-primary",
  secondary: "bg-canvas text-ink border border-line-strong border-b-[3px] hover:bg-surface active:border-b active:translate-y-[2px] disabled:opacity-40",
  ghost: "bg-transparent text-ink-secondary border border-transparent hover:bg-surface hover:text-ink disabled:opacity-40",
  danger: "bg-canvas text-danger-fg border border-danger border-b-[3px] hover:bg-surface active:border-b active:translate-y-[2px] disabled:opacity-40",
  ink: "bg-ink text-canvas border border-ink border-b-[3px] border-b-black/40 hover:opacity-90 active:border-b active:translate-y-[2px] disabled:opacity-40",
};
const sizeClass: Record<Size, string> = {
  sm: "h-9 px-3 text-[13px]",
  md: "h-11 px-4 text-[15px]",
  lg: "h-12 px-5 text-[16px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  full?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", size = "md", loading, full, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[6px] font-medium transition-fast transition-[background-color,opacity,border-color,transform,box-shadow] select-none min-h-[44px] tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
        variantClass[variant],
        sizeClass[size],
        full && "w-full",
        className,
      )}
      {...rest}
    >
      {loading && <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
});

export function LinkButton({ href, variant = "secondary", size = "md", full, className, children }: { href: string; variant?: Variant; size?: Size; full?: boolean; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cx("inline-flex items-center justify-center gap-2 rounded-[6px] font-medium transition-fast min-h-[44px] tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas", variantClass[variant], sizeClass[size], full && "w-full", className)}>
      {children}
    </Link>
  );
}

/* ---------- Module (bordered panel) ---------- */

export function Module({ className, children, as: Tag = "section", ticks, ...rest }: HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "article" | "aside"; ticks?: boolean }) {
  return (
    <Tag className={cx("border border-line rounded-[8px] bg-canvas", ticks && "ticks", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function ModuleHeader({ title, action, index, className }: { title: ReactNode; action?: ReactNode; index?: string; className?: string }) {
  return (
    <div className={cx("flex items-center justify-between gap-3 px-4 py-3 border-b border-line", className)}>
      <h2 className="eyebrow">
        {index && <span className="text-primary">{index}</span>}
        {title}
      </h2>
      {action}
    </div>
  );
}

/* ---------- Label + Stat ---------- */

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("eyebrow", className)}>{children}</div>;
}

export function Stat({ label, value, sub, className, size = "md" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string; size?: "md" | "lg" | "xl" }) {
  const valueClass = size === "xl" ? "text-[44px] md:text-[60px] leading-none" : size === "lg" ? "text-[30px] leading-tight" : "text-[20px] leading-tight";
  return (
    <div className={cx("p-4 md:p-5 flex flex-col gap-2", className)}>
      <Label>{label}</Label>
      <div className={cx("display num", valueClass)}>{value}</div>
      {sub && <div className="text-[13px] text-ink-secondary num">{sub}</div>}
    </div>
  );
}

/* ---------- Chip ---------- */

export function Chip({ active, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(
        "h-9 min-h-[36px] px-3 rounded-[6px] border text-[13px] font-medium transition-fast whitespace-nowrap",
        active ? "border-primary text-primary bg-primary-soft" : "border-line text-ink-secondary hover:border-line-strong hover:text-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------- Badge ---------- */

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "positive" | "danger" | "primary" | "warning"; children: ReactNode; className?: string }) {
  const toneClass = {
    neutral: "border-line text-ink-secondary",
    positive: "border-positive text-positive-fg",
    danger: "border-danger text-danger-fg",
    primary: "border-primary text-primary bg-primary-soft",
    warning: "border-line-strong text-ink",
  }[tone];
  return <span className={cx("inline-flex items-center h-6 px-2 rounded-[4px] border text-[11px] font-mono uppercase tracking-[0.08em]", toneClass, className)}>{children}</span>;
}

/* ---------- Skeleton ---------- */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-[6px] bg-surface-muted", className)} />;
}

/* ---------- Rows ---------- */

export function Row({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("flex items-center justify-between gap-3 px-4 py-3 border-b border-line last:border-b-0", className)} {...rest}>
      {children}
    </div>
  );
}

export function KeyValue({ k, v, mono = true }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[14px] border-b border-dashed border-line last:border-b-0">
      <span className="text-ink-secondary shrink-0">{k}</span>
      <span className={cx("text-right text-ink min-w-0 break-words", mono && "font-mono num text-[13px]")}>{v}</span>
    </div>
  );
}

/* ---------- Page heading ---------- */

export function PageTitle({ index, title, lead, action }: { index?: string; title: ReactNode; lead?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="reveal">
        {index && <div className="eyebrow mb-2">{index}</div>}
        <h1 className="display text-[36px] md:text-[48px] leading-[0.95]">{title}</h1>
        {lead && <p className="mt-3 max-w-[60ch] text-ink-secondary text-[15px]">{lead}</p>}
      </div>
      {action}
    </div>
  );
}

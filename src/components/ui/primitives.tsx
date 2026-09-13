import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import Link from "next/link";
import { buttonBaseClass, buttonSizeClass, buttonVariantClass, type ButtonSize, type ButtonVariant } from "./button-styles";
import { cx } from "./cx";

// No "use client" here: nothing below uses a hook or browser state, so a server page can render a
// Module or a LinkButton without pulling a client bundle for it. `Button` is the exception (it
// takes handlers) and lives in its own client file; it is re-exported so every existing import of
// `{ Button } from "@/components/ui/primitives"` keeps working.
export { Button, type ButtonProps } from "./Button";
export { cx };

/* ---------- LinkButton ---------- */

export function LinkButton({ href, variant = "secondary", size = "md", full, className, children }: { href: string; variant?: ButtonVariant; size?: ButtonSize; full?: boolean; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cx(buttonBaseClass, buttonVariantClass[variant], buttonSizeClass[size], full && "w-full", className)}>
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
    // The action holds a control — a segmented range, a select, a button — and a control squeezed
    // by a long title is a broken one. The title gives way first, and on a narrow screen the row
    // wraps rather than crushing either.
    <div className={cx("flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 border-b border-line", className)}>
      <h2 className="eyebrow min-w-0">
        {index && <span className="text-primary">{index}</span>}
        {title}
      </h2>
      {action && <span className="shrink-0">{action}</span>}
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
    positive: "border-positive/70 text-positive-fg bg-positive-soft",
    danger: "border-danger/70 text-danger-fg bg-danger-soft",
    primary: "border-primary text-primary bg-primary-soft",
    warning: "border-warning/70 text-warning-fg bg-warning-soft",
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

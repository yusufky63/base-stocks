import { cx } from "@/components/ui/primitives";

/**
 * BStocks mark: three ascending blocks on a baseline — modular squares (never the Base Square)
 * reading as "stocks, built from blocks". Inline version follows the theme via currentColor.
 */
export function LogoMark({ size = 24, className, solid = false }: { size?: number; className?: string; solid?: boolean }) {
  if (solid) {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" className={cx("shrink-0", className)} aria-hidden>
        <rect width="64" height="64" rx="14" fill="var(--primary)" />
        <rect x="11" y="37" width="14" height="14" rx="2.5" fill="#fff" opacity="0.72" />
        <rect x="25" y="24" width="14" height="14" rx="2.5" fill="#fff" opacity="0.86" />
        <rect x="39" y="11" width="14" height="14" rx="2.5" fill="#fff" />
        <rect x="11" y="53" width="42" height="3" rx="1.5" fill="#fff" opacity="0.5" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cx("shrink-0", className)} aria-hidden>
      <rect x="6" y="38" width="16" height="16" rx="3" fill="currentColor" opacity="0.55" />
      <rect x="24" y="24" width="16" height="16" rx="3" fill="currentColor" opacity="0.8" />
      <rect x="42" y="10" width="16" height="16" rx="3" fill="var(--primary)" />
      <rect x="6" y="57" width="52" height="3" rx="1.5" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

export function Wordmark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <span className={cx("inline-flex items-center gap-2 select-none", className)}>
      <LogoMark size={size} />
      <span className="display tracking-[-0.045em] leading-none" style={{ fontSize: size * 0.95 }}>
        B<span className="text-primary">Stocks</span>
      </span>
    </span>
  );
}

import { cx } from "@/components/ui/primitives";

/** Header lockup: the raster mark from public/brand (trial logo) next to the wordmark text. */
export function Wordmark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <span className={cx("inline-flex items-center gap-2 select-none", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-mark-transparent-128.png" alt="" width={size + 8} height={size + 8} className="shrink-0" style={{ width: size + 8, height: size + 8 }} />
      <span className="display tracking-[-0.045em] leading-none" style={{ fontSize: size * 0.95 }}>
        <span className="text-primary">Base</span>Stocks
      </span>
    </span>
  );
}

/** X (Twitter) mark, drawn to sit on the same optical size as the outline icon set. */
export function XMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

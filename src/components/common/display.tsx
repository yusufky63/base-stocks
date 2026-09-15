"use client";

import { useState } from "react";
import { Check, CircleAlert, CircleCheck, Copy, ExternalLink, Info, TriangleAlert } from "lucide-react";
import type { Address } from "viem";
import { formatPct, shortenAddress } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { BASE_EXPLORER_URL } from "@/config/chain";

/** Token / stock logo with a typographic fallback (no emoji, no 3D). */
export function AssetLogo({ src, symbol, size = 36, className }: { src?: string; symbol: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const label = symbol.replace(/c$/, "").slice(0, 4);
  if (!src || failed) {
    return (
      <span aria-hidden className={cx("inline-flex items-center justify-center rounded-[6px] border border-line bg-surface font-mono text-[11px] text-ink-secondary shrink-0", className)} style={{ width: size, height: size }}>
        {label}
      </span>
    );
  }
  // Lazy and async: a markets list draws dozens of these, most below the fold, and none of them
  // should hold up the first paint.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className={cx("rounded-[6px] border border-line bg-canvas object-cover shrink-0", className)} style={{ width: size, height: size }} />;
}

/** Signed percentage with color AND sign, plus a screen-reader label. */
export function PriceChange({ value, className, digits = 2 }: { value: number | null | undefined; className?: string; digits?: number }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cx("text-ink-muted num", className)}>—</span>;
  const tone = value > 0 ? "text-positive-fg" : value < 0 ? "text-danger-fg" : "text-ink-secondary";
  return (
    <span className={cx("num", tone, className)}>
      <span className="sr-only">{value > 0 ? "up" : value < 0 ? "down" : "unchanged"} </span>
      {formatPct(value, { digits })}
    </span>
  );
}

export function AddressLabel({ address, basename, showCopy = true, explorer = false, className }: { address: Address; basename?: string | null; showCopy?: boolean; explorer?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <span className={cx("inline-flex items-center gap-2 min-w-0", className)}>
      <span className="min-w-0">
        {basename && <span className="block text-[14px] text-ink truncate">{basename}</span>}
        <span className="block font-mono text-[12px] text-ink-secondary truncate">{shortenAddress(address, 6)}</span>
      </span>
      {showCopy && (
        <button type="button" aria-label="Copy address" onClick={copy} className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
          {copied ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
        </button>
      )}
      {explorer && (
        <a href={`${BASE_EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" aria-label="View on Basescan" className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
          <ExternalLink size={14} strokeWidth={1.75} />
        </a>
      )}
    </span>
  );
}

export function ErrorBanner({ message, detail, onRetry, className }: { message: string; detail?: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx("border border-danger/60 bg-danger-soft rounded-[8px] px-4 py-3 text-[14px] text-ink", className)}>
      <div className="flex items-start justify-between gap-3">
        <span className="flex items-start gap-2.5">
          <CircleAlert size={15} strokeWidth={1.75} className="shrink-0 mt-[3px] text-danger-fg" aria-hidden />
          <span>{message}</span>
        </span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="text-primary text-[13px] font-medium shrink-0 min-h-[44px] -my-2">
            Retry
          </button>
        )}
      </div>
      {detail && <div className="mt-1 font-mono text-[11px] text-ink-muted break-all">{detail}</div>}
    </div>
  );
}

/** Remaining AI requests for this wallet today; loud when only a few are left. */
export function AiQuotaNote({ remaining, className }: { remaining: number | null | undefined; className?: string }) {
  if (remaining === null || remaining === undefined) return null;
  if (remaining <= 0) return <span className={cx("font-medium text-danger-fg", className)}>No AI requests left today for this wallet. The allowance resets at 00:00 UTC.</span>;
  if (remaining <= 3) return <span className={cx("font-medium text-warning-fg", className)}>{remaining === 1 ? "Last AI request today for this wallet." : `Last ${remaining} AI requests today for this wallet.`}</span>;
  return <span className={className}>{remaining} AI requests left today.</span>;
}

export type BannerTone = "neutral" | "info" | "warning" | "positive" | "danger";

/**
 * Tone is colour and an icon, not just a border: amber for "look before you sign", green for
 * "it landed", red for "it did not", blue for "this is how it works". Neutral stays quiet.
 */
const BANNER: Record<BannerTone, { box: string; icon: typeof Info | null; iconClass: string }> = {
  neutral: { box: "border-line bg-surface text-ink-secondary", icon: null, iconClass: "" },
  info: { box: "border-primary/40 bg-primary-soft text-ink", icon: Info, iconClass: "text-primary" },
  warning: { box: "border-warning/60 bg-warning-soft text-ink", icon: TriangleAlert, iconClass: "text-warning-fg" },
  positive: { box: "border-positive/60 bg-positive-soft text-ink", icon: CircleCheck, iconClass: "text-positive-fg" },
  danger: { box: "border-danger/60 bg-danger-soft text-ink", icon: CircleAlert, iconClass: "text-danger-fg" },
};

export function InfoBanner({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: BannerTone; className?: string }) {
  const t = BANNER[tone];
  const Icon = t.icon;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("flex items-start gap-2.5 border rounded-[8px] px-4 py-3 text-[13px]", t.box, className)}>
      {Icon && <Icon size={15} strokeWidth={1.75} className={cx("shrink-0 mt-0.5", t.iconClass)} aria-hidden />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function LegalNotice({ compact = false }: { compact?: boolean }) {
  return (
    <p className={cx("text-ink-muted", compact ? "text-[12px]" : "text-[13px] leading-relaxed")}>
      Coinbase Tokenized Stocks are available only to persons in eligible jurisdictions outside the United States. Availability is subject to onchain issuer policies. BStocks is an independent interface built on Base, not an official Base or Coinbase product, and does not provide investment advice. Portfolio templates are not recommendations. Estimated yields are variable and never guaranteed.
    </p>
  );
}

export function TxLink({ hash, children }: { hash: string; children?: React.ReactNode }) {
  return (
    <a href={`${BASE_EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary text-[13px] font-medium">
      {children ?? "View on Basescan"} <ExternalLink size={13} strokeWidth={1.75} />
    </a>
  );
}

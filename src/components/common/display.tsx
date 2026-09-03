"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { Address } from "viem";
import { formatPct, shortenAddress } from "@/lib/format";
import { cx } from "@/components/ui/primitives";
import { BASE_EXPLORER_URL } from "@/config/chain";
import { useBasename } from "@/hooks/queries";

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
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} className={cx("rounded-[6px] border border-line bg-canvas object-cover shrink-0", className)} style={{ width: size, height: size }} />;
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

/** Identity: Basename first, address second (resolved client-side, cached). */
export function Identity({ address, className }: { address: Address; className?: string }) {
  const { data } = useBasename(address);
  return <AddressLabel address={address} basename={data?.name} showCopy={false} className={className} />;
}

export function ErrorBanner({ message, detail, onRetry, className }: { message: string; detail?: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={cx("border border-danger rounded-[8px] px-4 py-3 text-[14px] text-ink", className)}>
      <div className="flex items-start justify-between gap-3">
        <span>{message}</span>
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

export function InfoBanner({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: "neutral" | "warning"; className?: string }) {
  return (
    <div role="status" className={cx("border rounded-[8px] px-4 py-3 text-[13px] text-ink-secondary", tone === "warning" ? "border-line-strong" : "border-line", className)}>
      {children}
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

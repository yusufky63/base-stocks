"use client";

import Link from "next/link";
import { BadgeCheck, ExternalLink } from "lucide-react";
import type { ResolvedRecipient } from "@/domain/gift";
import { BASE_EXPLORER_URL } from "@/config/chain";
import { isBrandLikeName } from "@/lib/gift/format";
import { shortenAddress } from "@/lib/format";
import { assetColor } from "@/lib/colors";
import { cx } from "@/components/ui/primitives";

/**
 * Who a send or gift goes to, resolved server-side: Basename (also reverse-resolved from a raw
 * address), Basename avatar, and the BStocks profile when the recipient has signed in here.
 */
export function RecipientCard({ r, className, compact = false }: { r: ResolvedRecipient; className?: string; compact?: boolean }) {
  // The Basename is the identity; a display name is only a label, dropped when it reads like the brand.
  const displayName = r.profile?.displayName && !isBrandLikeName(r.profile.displayName) ? r.profile.displayName : null;
  const name = r.basename ?? displayName;
  const member = !!r.profile;
  const profileHref = r.profile && r.profile.isPublic ? `/u/${r.address}` : null;
  const secondary = [shortenAddress(r.address, 6), r.basename && displayName ? displayName : null].filter(Boolean).join(" · ");
  return (
    <div className={cx("flex items-center gap-3 min-w-0", !compact && "border border-line rounded-[8px] px-3 py-2 bg-surface", className)}>
      <Avatar src={r.avatar} seed={r.address} label={name ?? r.address.slice(2)} size={compact ? 28 : 36} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={cx("truncate", name ? "text-[14px] text-ink" : "font-mono text-[13px] text-ink")}>{name ?? shortenAddress(r.address, 6)}</span>
          {member && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-primary shrink-0" title={r.profile?.memberSince ? `BStocks member since ${new Date(r.profile.memberSince).toISOString().slice(0, 10)}` : "BStocks member"}>
              <BadgeCheck size={12} strokeWidth={2} /> member
            </span>
          )}
        </span>
        <span className="block font-mono text-[11px] text-ink-secondary truncate">{name ? secondary : "no Basename · new to BStocks"}</span>
      </span>
      {profileHref ? (
        <Link href={profileHref} className="shrink-0 text-[12px] font-medium text-primary hover:underline">
          Profile
        </Link>
      ) : (
        <a href={`${BASE_EXPLORER_URL}/address/${r.address}`} target="_blank" rel="noreferrer noopener" aria-label="View on Basescan" className="shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
          <ExternalLink size={14} strokeWidth={1.75} />
        </a>
      )}
    </div>
  );
}

export function Avatar({ src, seed, label, size = 36 }: { src?: string | null; seed: string; label: string; size?: number }) {
  const initial = label.replace(/^@/, "").slice(0, 1).toUpperCase();
  if (src && /^https?:\/\//.test(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={size} height={size} className="rounded-full object-cover shrink-0 bg-surface-muted" style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden className="rounded-full shrink-0 inline-flex items-center justify-center font-mono text-[12px] font-medium text-white" style={{ width: size, height: size, background: assetColor(seed) }}>
      {initial}
    </span>
  );
}

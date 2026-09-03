"use client";

import { useState } from "react";
import type { EarnProviderId } from "@/domain/earn";
import { cx } from "@/components/ui/primitives";

const META: Record<EarnProviderId, { slug: string; label: string; color: string }> = {
  morpho: { slug: "morpho", label: "Morpho", color: "#2470ff" },
  aave: { slug: "aave", label: "Aave", color: "#b6509e" },
  compound: { slug: "compound-v3", label: "Compound", color: "#00d395" },
  aerodrome: { slug: "aerodrome", label: "Aerodrome", color: "#2563eb" },
  uniswap: { slug: "uniswap", label: "Uniswap", color: "#ff007a" },
};

export const PROTOCOL_LABEL: Record<EarnProviderId, string> = Object.fromEntries(Object.entries(META).map(([k, v]) => [k, v.label])) as Record<EarnProviderId, string>;

/**
 * Protocol mark from DefiLlama's public icon CDN (same source many explorers use), with a lettered
 * fallback when the image cannot load. Optional label so venue rows read "logo · Morpho".
 */
export function ProtocolLogo({ provider, size = 18, withLabel = false, label, className }: { provider: EarnProviderId; size?: number; withLabel?: boolean; label?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const m = META[provider];
  const text = label ?? m.label;
  return (
    <span className={cx("inline-flex items-center gap-1.5 min-w-0", className)}>
      {failed ? (
        <span aria-hidden className="rounded-full shrink-0 inline-flex items-center justify-center font-mono text-[10px] font-medium text-white" style={{ width: size, height: size, background: m.color }}>
          {m.label.charAt(0)}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://icons.llamao.fi/icons/protocols/${m.slug}?w=${size * 2}&h=${size * 2}`} alt={withLabel ? "" : m.label} width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="rounded-full shrink-0 bg-surface-muted" style={{ width: size, height: size }} />
      )}
      {withLabel && <span className="truncate">{text}</span>}
    </span>
  );
}

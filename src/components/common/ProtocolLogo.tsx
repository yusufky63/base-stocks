"use client";

import { useState } from "react";
import type { EarnProviderId } from "@/domain/earn";
import { EARN_PROVIDER_INTEGRATION } from "@/content/integrations";
import { cx } from "@/components/ui/primitives";

export const PROTOCOL_LABEL: Record<EarnProviderId, string> = Object.fromEntries(Object.entries(EARN_PROVIDER_INTEGRATION).map(([k, v]) => [k, v.name])) as Record<EarnProviderId, string>;

/**
 * Protocol mark from DefiLlama's public icon CDN (same source many explorers use), with a lettered
 * fallback when the image cannot load. Optional label so venue rows read "logo · Morpho". Slug and
 * colour come from the integrations list, the same source the docs and the footer strip draw from.
 */
export function ProtocolLogo({ provider, size = 18, withLabel = false, label, className }: { provider: EarnProviderId; size?: number; withLabel?: boolean; label?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const m = EARN_PROVIDER_INTEGRATION[provider];
  const text = label ?? m.name;
  return (
    <span className={cx("inline-flex items-center gap-1.5 min-w-0", className)}>
      {failed || !m.mark ? (
        <span aria-hidden className="rounded-full shrink-0 inline-flex items-center justify-center font-mono text-[10px] font-medium text-white" style={{ width: size, height: size, background: m.color }}>
          {m.name.charAt(0)}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://icons.llamao.fi/icons/protocols/${m.mark}?w=${size * 2}&h=${size * 2}`} alt={withLabel ? "" : m.name} width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="rounded-full shrink-0 bg-surface-muted" style={{ width: size, height: size }} />
      )}
      {withLabel && <span className="truncate">{text}</span>}
    </span>
  );
}

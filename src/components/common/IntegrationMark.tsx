"use client";

import { useState } from "react";
import { cx } from "@/components/ui/primitives";

/**
 * Mark for any integrated platform: DefiLlama's icon CDN when a slug exists, otherwise a lettered
 * badge in the platform's colour. Same look as ProtocolLogo, without being tied to Earn providers.
 */
export function IntegrationMark({ name, mark, color, size = 18, className }: { name: string; mark: string | null; color: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!mark || failed) {
    return (
      <span aria-hidden className={cx("rounded-full shrink-0 inline-flex items-center justify-center font-mono font-medium text-white", className)} style={{ width: size, height: size, background: color, fontSize: Math.max(9, Math.round(size * 0.5)) }}>
        {name.charAt(0)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`https://icons.llamao.fi/icons/protocols/${mark}?w=${size * 2}&h=${size * 2}`} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={cx("rounded-full shrink-0 bg-surface-muted", className)} style={{ width: size, height: size }} />
  );
}

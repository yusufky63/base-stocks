"use client";

import { assetColor } from "@/lib/colors";
import { bpsToPct } from "@/lib/format";
import { cx } from "@/components/ui/primitives";

export interface AllocationSegment {
  /** Address, ticker or "USDC". */
  key: string;
  label: string;
  weightBps: number;
}

/** Coloured, labelled allocation bar with a legend. Colour + label + percent, never colour alone. */
export function AllocationBar({ segments, height = 12, legend = true, className }: { segments: AllocationSegment[]; height?: number; legend?: boolean; className?: string }) {
  const total = segments.reduce((s, x) => s + x.weightBps, 0) || 1;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <div className="w-full rounded-full overflow-hidden flex gap-px bg-surface-muted" style={{ height }} aria-hidden>
        {segments.map((s) => (
          <div key={s.key} className="h-full transition-base" style={{ width: `${(s.weightBps / total) * 100}%`, background: assetColor(s.key) }} title={`${s.label} ${bpsToPct(s.weightBps)}`} />
        ))}
      </div>
      {legend && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {segments.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ink-secondary">
              <span className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: assetColor(s.key) }} aria-hidden />
              <span className="text-ink">{s.label}</span>
              <span className="num">{bpsToPct(s.weightBps)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ColorDot({ k, className, size = 10 }: { k: string; className?: string; size?: number }) {
  return <span className={cx("inline-block rounded-[3px] shrink-0", className)} style={{ width: size, height: size, background: assetColor(k) }} aria-hidden />;
}

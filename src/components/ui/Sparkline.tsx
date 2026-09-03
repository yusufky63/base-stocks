"use client";

import { cx } from "./primitives";

interface Props {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Force a tone; otherwise derived from first vs last point. */
  tone?: "up" | "down" | "flat";
}

/** Tiny inline trend line. Colour is never the only signal — pair it with a signed % nearby. */
export function Sparkline({ points, width = 84, height = 28, className, tone }: Props) {
  if (points.length < 2) return <span className={cx("inline-block", className)} style={{ width, height }} aria-hidden />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  const t = tone ?? (points[points.length - 1]! > points[0]! ? "up" : points[points.length - 1]! < points[0]! ? "down" : "flat");
  const color = t === "up" ? "var(--positive-fg)" : t === "down" ? "var(--danger-fg)" : "var(--text-muted)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx("shrink-0", className)} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={((points.length - 1) * step).toFixed(1)} cy={(height - 2 - ((points[points.length - 1]! - min) / span) * (height - 4)).toFixed(1)} r="2" fill={color} />
    </svg>
  );
}

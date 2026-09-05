"use client";

import { cx } from "./primitives";

interface Props {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Force a tone; otherwise derived from first vs last point. */
  tone?: "up" | "down" | "flat";
  /** A second series drawn dashed and muted on the same scale — a benchmark behind the line. */
  compare?: number[];
}

/** Tiny inline trend line. Colour is never the only signal — pair it with a signed % nearby. */
export function Sparkline({ points, width = 84, height = 28, className, tone, compare }: Props) {
  if (points.length < 2) return <span className={cx("inline-block", className)} style={{ width, height }} aria-hidden />;
  const cmp = compare && compare.length > 1 ? compare : null;
  const min = Math.min(...points, ...(cmp ?? []));
  const max = Math.max(...points, ...(cmp ?? []));
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  const cstep = cmp ? width / (cmp.length - 1) : 0;
  const cd = cmp ? cmp.map((p, i) => `${i === 0 ? "M" : "L"}${(i * cstep).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join(" ") : null;
  const t = tone ?? (points[points.length - 1]! > points[0]! ? "up" : points[points.length - 1]! < points[0]! ? "down" : "flat");
  const color = t === "up" ? "var(--positive-fg)" : t === "down" ? "var(--danger-fg)" : "var(--text-muted)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx("shrink-0", className)} aria-hidden>
      {cd && <path d={cd} fill="none" stroke="var(--text-muted)" strokeWidth="1.25" strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round" opacity="0.8" />}
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={((points.length - 1) * step).toFixed(1)} cy={(height - 2 - ((points[points.length - 1]! - min) / span) * (height - 4)).toFixed(1)} r="2" fill={color} />
    </svg>
  );
}

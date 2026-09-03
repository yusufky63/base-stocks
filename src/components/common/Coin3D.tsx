"use client";

import { useRef, type CSSProperties, type PointerEvent } from "react";
import { coinSrc } from "@/lib/coins";
import { AssetLogo } from "@/components/common/display";

/**
 * A pre-rendered 3D coin with two cheap effects: an optional idle float (CSS keyframes on the
 * wrapper, with a shadow that shrinks as the coin rises) and a pointer tilt (perspective rotate on
 * the image, driven by two CSS variables). No canvas, no per-frame JS, honours reduced motion via
 * the global motion rules. Falls back to the flat token logo when no render exists for the ticker.
 */
export function Coin3D({
  underlying,
  symbol,
  fallbackSrc,
  size = 40,
  float = false,
  tilt = true,
  muted = false,
  delay = 0,
  className,
}: {
  underlying?: string | null;
  symbol?: string;
  fallbackSrc?: string;
  size?: number;
  /** Idle bob; use sparingly (hero, page headers). */
  float?: boolean;
  /** Follow the pointer with a small perspective tilt. */
  tilt?: boolean;
  /** Grayscale and dimmed, for stocks that are not issued yet. */
  muted?: boolean;
  /** Stagger the float so neighbouring coins do not move in lockstep. */
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const src = coinSrc(underlying, size > 200 ? "full" : "small");
  if (!src) return <AssetLogo src={fallbackSrc} symbol={symbol ?? underlying ?? "?"} size={size} className={className} />;

  const onMove = (e: PointerEvent<HTMLSpanElement>) => {
    const el = ref.current;
    if (!tilt || !el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--tilt-x", `${(-py * 20).toFixed(1)}deg`);
    el.style.setProperty("--tilt-y", `${(px * 20).toFixed(1)}deg`);
  };
  const onLeave = () => {
    ref.current?.style.setProperty("--tilt-x", "0deg");
    ref.current?.style.setProperty("--tilt-y", "0deg");
  };
  const classes = ["coin", float ? "coin-float" : "", muted ? "coin-muted" : "", className ?? ""].filter(Boolean).join(" ");
  const style = { width: size, height: size, animationDelay: `${delay}ms` } as CSSProperties;
  return (
    <span ref={ref} onPointerMove={onMove} onPointerLeave={onLeave} className={classes} style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" width={size} height={size} draggable={false} className="coin-img" style={{ width: size, height: size }} />
      <span aria-hidden className="coin-shadow" style={{ animationDelay: `${delay}ms` }} />
    </span>
  );
}

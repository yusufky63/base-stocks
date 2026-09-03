"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cx } from "@/components/ui/primitives";
import { useMotion } from "@/lib/motion";

interface Props {
  text: string;
  size?: number;
  /** Seconds per revolution at rest. */
  spinDuration?: number;
  /** Behaviour while hovered. */
  onHover?: "speedUp" | "slowDown" | "pause" | "goBonkers";
  className?: string;
  children?: ReactNode;
}

/**
 * Rotating circular text (after reactbits.dev/text-animations/circular-text) without a motion
 * library: letters are laid out on a ring and the ring spins via requestAnimationFrame with an
 * eased speed change on hover. Decorative only (aria-hidden), static under reduced motion.
 */
export function CircularText({ text, size = 180, spinDuration = 20, onHover = "speedUp", className, children }: Props) {
  const ring = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const { enabled } = useMotion();

  useEffect(() => {
    const el = ring.current;
    if (!el) return;
    if (!enabled) return;
    let angle = 0;
    let speed = 360 / spinDuration; // deg per second
    let raf = 0;
    let last = performance.now();
    const base = 360 / spinDuration;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const target = hovered.current ? (onHover === "speedUp" ? base * 4 : onHover === "slowDown" ? base * 0.25 : onHover === "pause" ? 0 : base * 12) : base;
      speed += (target - speed) * Math.min(1, dt * 6);
      angle = (angle + speed * dt) % 360;
      el.style.transform = `rotate(${angle}deg)`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [spinDuration, onHover, enabled]);

  const letters = Array.from(text);
  const radius = size / 2 - 10;

  return (
    <div
      className={cx("relative inline-flex items-center justify-center select-none", className)}
      style={{ width: size, height: size }}
      onMouseEnter={() => (hovered.current = true)}
      onMouseLeave={() => (hovered.current = false)}
      aria-hidden
    >
      <div ref={ring} className="absolute inset-0 will-change-transform">
        {letters.map((ch, i) => {
          const rot = (360 / letters.length) * i;
          return (
            <span
              key={`${ch}-${i}`}
              className="absolute left-1/2 top-1/2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-secondary"
              style={{ transform: `translate(-50%, -50%) rotate(${rot}deg) translateY(-${radius}px)` }}
            >
              {ch === " " ? " " : ch}
            </span>
          );
        })}
      </div>
      {children && <div className="relative">{children}</div>}
    </div>
  );
}

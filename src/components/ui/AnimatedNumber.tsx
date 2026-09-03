"use client";

import { useEffect, useRef, useState } from "react";
import { motionEnabled } from "@/lib/motion";

interface Props {
  value: number | null | undefined;
  format: (v: number) => string;
  className?: string;
  durationMs?: number;
}

/** Subtle numeric tween (spec §54): 240ms, one easing family, honours reduced motion. */
export function AnimatedNumber({ value, format, className, durationMs = 240 }: Props) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const prev = useRef<number | null>(value ?? null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (value === null || value === undefined) return;
    const from = prev.current;
    prev.current = value;
    const reduced = !motionEnabled();
    if (from === null || reduced || from === value) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(from + (value - from) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, durationMs]);

  return <span className={className}>{shown === null ? "—" : format(shown)}</span>;
}

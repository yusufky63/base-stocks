"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./primitives";

/**
 * Sticky sidebar without an inner scrollbar. While the panel fits under the header it sticks at
 * `offset`; when it is taller than the viewport its `top` goes negative so the page scrolls it
 * until the bottom edge is visible, then it sticks there. Never overlaps content below the column.
 */
export function StickyPanel({ offset = 72, gap = 16, className, children }: { offset?: number; gap?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(offset);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const h = el.offsetHeight;
        const vh = window.innerHeight;
        setTop(h + offset + gap > vh ? vh - h - gap : offset);
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [offset, gap]);
  return (
    <div ref={ref} className={cx("sticky self-start", className)} style={{ top }}>
      {children}
    </div>
  );
}

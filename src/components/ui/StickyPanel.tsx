"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./primitives";

/** The shell publishes the sticky header's height as `--header-h`; 56px is the header alone, before the ticker rows. */
function headerHeight(): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-h"));
  return Number.isFinite(v) ? v : 56;
}

/**
 * Sticky sidebar without an inner scrollbar. While the panel fits under the header it sticks just
 * below it (`offset`, by default the measured header height plus the gap, so the ticker rows are
 * cleared too); when it is taller than the viewport its `top` goes negative so the page scrolls it
 * until the bottom edge is visible, then it sticks there. Never overlaps content below the column.
 */
export function StickyPanel({ offset, gap = 16, className, children }: { offset?: number; gap?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(offset ?? 56 + gap);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const h = el.offsetHeight;
        const vh = window.innerHeight;
        const clear = offset ?? headerHeight() + gap;
        setTop(h + clear + gap > vh ? vh - h - gap : clear);
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // The header band itself resizes when a ticker row is switched on or off.
    const band = document.querySelector("header")?.parentElement;
    if (band) ro.observe(band);
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

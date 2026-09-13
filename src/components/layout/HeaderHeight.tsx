"use client";

import { useEffect, useRef } from "react";

/**
 * Publishes the sticky header band's height as `--header-h` on <html>.
 *
 * The band is not a fixed size: the ticker rows above the header can be switched on and off, and
 * the mini app host adds a safe-area inset. Anchors (`scroll-mt-header`) and sticky side panels
 * (`top-header`) read the variable instead of guessing, so a section opened from a link is not
 * hidden under the header. Rendered as the last child of the band and measures its parent.
 */
export function HeaderHeight() {
  const probe = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const band = probe.current?.parentElement;
    if (!band) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--header-h", `${Math.round(band.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(band);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--header-h");
    };
  }, []);

  return <span ref={probe} hidden aria-hidden />;
}

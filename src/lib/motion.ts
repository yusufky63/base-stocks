"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Motion preference. "system" (the default) follows the OS "reduce motion" setting, "on" plays
 * every animation regardless of it, "off" disables all of them. The OS preference is the default
 * because a visitor who asked their device for less motion should not have to find a second
 * switch here; "on" exists for the one who wants the ticker back anyway.
 */
export type MotionPreference = "on" | "off" | "system";

const KEY = "bstocks:motion";
const EVENT = "bstocks:motion";
const DEFAULT: MotionPreference = "system";

export function readMotionPreference(): MotionPreference {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "on" || v === "off" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

/** True when animations should run right now. */
export function motionEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const pref = readMotionPreference();
  if (pref === "on") return true;
  if (pref === "off") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function apply(pref: MotionPreference) {
  document.documentElement.setAttribute("data-motion", pref);
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
    mq.removeEventListener("change", cb);
  };
}

export function useMotion() {
  const preference = useSyncExternalStore(subscribe, readMotionPreference, () => DEFAULT);
  const enabled = useSyncExternalStore(subscribe, motionEnabled, () => true);
  const setPreference = useCallback((p: MotionPreference) => {
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
    apply(p);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { preference, enabled, setPreference };
}

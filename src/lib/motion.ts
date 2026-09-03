"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Motion preference. "on" plays every animation, "off" disables all of them, "system" follows the
 * OS "reduce motion" setting. Default is "on" (product decision); the OS preference still wins when
 * the user picks "system" in Settings.
 */
export type MotionPreference = "on" | "off" | "system";

const KEY = "bstocks:motion";
const EVENT = "bstocks:motion";

export function readMotionPreference(): MotionPreference {
  if (typeof window === "undefined") return "on";
  try {
    const v = localStorage.getItem(KEY);
    if (v === "on" || v === "off" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "on";
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
  const preference = useSyncExternalStore(subscribe, readMotionPreference, () => "on" as MotionPreference);
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

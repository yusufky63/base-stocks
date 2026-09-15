"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_SLIPPAGE_BPS } from "@/config/chain";

const KEY = "bstocks:slippageBps";
const EVENT = "bstocks:settings";

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isInteger(v) && v >= 10 && v <= 500) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_SLIPPAGE_BPS;
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

/** User-adjustable slippage (bps), persisted locally, bounded to sane consumer limits. */
export function useSlippage() {
  const slippageBps = useSyncExternalStore(subscribe, read, () => DEFAULT_SLIPPAGE_BPS);
  const setSlippageBps = useCallback((v: number) => {
    const clamped = Math.min(500, Math.max(10, Math.round(v)));
    try {
      localStorage.setItem(KEY, String(clamped));
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { slippageBps, setSlippageBps };
}

/* ---------------- Top ticker rows ---------------- */

const TICKER_KEYS = { prices: "bstocks:ticker:prices", news: "bstocks:ticker:news" } as const;
export interface TickerSettings {
  prices: boolean;
  news: boolean;
}
/** Product default: prices on, headlines off (opt-in from Settings or the News page). */
const TICKER_DEFAULTS: TickerSettings = { prices: true, news: false };

let tickerSnapshot: TickerSettings = TICKER_DEFAULTS;
function readTicker(): TickerSettings {
  let prices = TICKER_DEFAULTS.prices;
  let news = TICKER_DEFAULTS.news;
  try {
    const p = localStorage.getItem(TICKER_KEYS.prices);
    const n = localStorage.getItem(TICKER_KEYS.news);
    if (p === "0" || p === "1") prices = p === "1";
    if (n === "0" || n === "1") news = n === "1";
  } catch {
    /* ignore */
  }
  if (tickerSnapshot.prices !== prices || tickerSnapshot.news !== news) tickerSnapshot = { prices, news };
  return tickerSnapshot;
}

/** Which rows the global top ticker shows; persisted locally, defaults never change silently. */
export function useTickerSettings() {
  const settings = useSyncExternalStore(subscribe, readTicker, () => TICKER_DEFAULTS);
  const set = useCallback((patch: Partial<TickerSettings>) => {
    try {
      if (patch.prices !== undefined) localStorage.setItem(TICKER_KEYS.prices, patch.prices ? "1" : "0");
      if (patch.news !== undefined) localStorage.setItem(TICKER_KEYS.news, patch.news ? "1" : "0");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { ...settings, set };
}

/* ---------------- Chart style ---------------- */

export type ChartStyle = "line" | "candles";
const CHART_KEY = "bstocks:chartStyle";

function readChartStyle(): ChartStyle {
  try {
    const v = localStorage.getItem(CHART_KEY);
    if (v === "candles" || v === "line") return v;
  } catch {
    /* ignore */
  }
  return "line";
}

/** Line or candlestick chart on stock pages; remembered per browser. */
export function useChartStyle() {
  const style = useSyncExternalStore(subscribe, readChartStyle, () => "line" as ChartStyle);
  const setStyle = useCallback((s: ChartStyle) => {
    try {
      localStorage.setItem(CHART_KEY, s);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { style, setStyle };
}

/* ---------------- Markets view ---------------- */

export type MarketsView = "list" | "heatmap";
const MARKETS_VIEW_KEY = "bstocks:marketsView";

function readMarketsView(): MarketsView {
  try {
    const v = localStorage.getItem(MARKETS_VIEW_KEY);
    if (v === "list" || v === "heatmap") return v;
  } catch {
    /* ignore */
  }
  return "list";
}

/** List or heatmap on the Markets page; the list by default, the choice remembered on this device. */
export function useMarketsView() {
  const view = useSyncExternalStore(subscribe, readMarketsView, () => "list" as MarketsView);
  const setView = useCallback((v: MarketsView) => {
    try {
      localStorage.setItem(MARKETS_VIEW_KEY, v);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { view, setView };
}

/* ---------------- Best execution ---------------- */

const BEST_EXECUTION_KEY = "bstocks:bestExecution";

function readBestExecution(): boolean {
  try {
    return localStorage.getItem(BEST_EXECUTION_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether trades prefer CoW Protocol's batch auction when it is competitive (the router's
 * BEST_EXECUTION_* constants say what competitive means). Off by default: a signed order waits
 * for a solver, which is the slower experience on a small trade; the panel suggests turning it
 * on once the trade is large enough for MEV protection and the solver's gas to matter.
 */
export function useBestExecution() {
  const enabled = useSyncExternalStore(subscribe, readBestExecution, () => false);
  const set = useCallback((v: boolean) => {
    try {
      localStorage.setItem(BEST_EXECUTION_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { enabled, set };
}

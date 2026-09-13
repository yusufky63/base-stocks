"use client";

import { useEffect, useRef } from "react";
import { createChart, AreaSeries, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, TickMarkType, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/domain/market";

export type ChartStyle = "line" | "candles";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * A theme colour with an alpha channel. The tokens are whatever CSS the theme uses (hex, rgb,
 * oklch), and the chart paints on a canvas, so the browser normalises the colour through a
 * throwaway context: an opaque colour reads back as `#rrggbb`, which takes a two-digit alpha.
 */
function withAlpha(color: string, alpha: number, fallback: string): string {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return fallback;
    ctx.fillStyle = color;
    const normalized = ctx.fillStyle;
    if (/^#[0-9a-f]{6}$/i.test(normalized)) return `${normalized}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
    return fallback;
  } catch {
    return fallback;
  }
}

function palette() {
  const primary = cssVar("--primary") || "#0370fd";
  return {
    text: cssVar("--text-muted") || "#717886",
    line: cssVar("--border") || "#dee1e7",
    primary,
    primarySoft: withAlpha(primary, 0.12, "rgba(3,112,253,0.12)"),
    up: cssVar("--positive") || "#16a34a",
    down: cssVar("--danger") || "#ef4444",
  };
}

/** The visitor's own clock, since the axis reads in it: "14:30" means their afternoon, and the label says so. */
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short" });
const yearFmt = new Intl.DateTimeFormat(undefined, { year: "numeric" });
const fullFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * TradingView Lightweight Charts: area (line) or candlesticks, with a volume histogram when the
 * series carries volume (DEX OHLCV). Theme-aware; touch enabled. Reference-feed series (Chainlink
 * rounds) have no volume, so the histogram simply stays hidden for them.
 *
 * `seriesKey` names the series (token, timeframe, source): the view is fitted to the data only
 * when it changes, so a background refresh of the same series keeps the zoom the reader chose.
 */
export function PriceChart({ candles, height = 320, style = "line", seriesKey = "" }: { candles: Candle[]; height?: number; style?: ChartStyle; seriesKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const fittedKey = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = palette();
    const chart = createChart(el, {
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: p.text, fontFamily: "Roboto Mono, ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: p.line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // The library labels ticks in UTC by default; the reader's own zone is what the rest of the page uses.
        tickMarkFormatter: (time: UTCTimestamp | { year: number; month: number; day: number } | string, type: TickMarkType) => {
          const d = typeof time === "number" ? new Date(time * 1000) : typeof time === "string" ? new Date(time) : new Date(time.year, time.month - 1, time.day);
          if (type === TickMarkType.Year) return yearFmt.format(d);
          if (type === TickMarkType.Month) return monthFmt.format(d);
          if (type === TickMarkType.DayOfMonth) return dayFmt.format(d);
          return timeFmt.format(d);
        },
      },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: p.text, width: 1, style: 2, labelBackgroundColor: p.primary }, horzLine: { color: p.text, width: 1, style: 2, labelBackgroundColor: p.primary } },
      // The wheel belongs to the page: a chart that zooms on scroll traps the reader above the
      // sections below it. Zoom is the +/- buttons, pinch on touch, or dragging the time axis.
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      localization: {
        priceFormatter: (v: number) => `$${v.toFixed(v < 10 ? 4 : 2)}`,
        timeFormatter: (time: UTCTimestamp | { year: number; month: number; day: number } | string) => fullFmt.format(typeof time === "number" ? new Date(time * 1000) : typeof time === "string" ? new Date(time) : new Date(time.year, time.month - 1, time.day)),
      },
    });
    if (style === "candles") {
      candleRef.current = chart.addSeries(CandlestickSeries, {
        upColor: p.up,
        downColor: p.down,
        borderUpColor: p.up,
        borderDownColor: p.down,
        wickUpColor: p.up,
        wickDownColor: p.down,
        priceLineVisible: true,
        lastValueVisible: true,
      });
    } else {
      areaRef.current = chart.addSeries(AreaSeries, {
        lineColor: p.primary,
        lineWidth: 2,
        topColor: p.primarySoft,
        bottomColor: "transparent",
        priceLineVisible: true,
        lastValueVisible: true,
        crosshairMarkerRadius: 4,
      });
    }
    volumeRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    chartRef.current = chart;
    // A new chart instance has no view yet, whatever series it is about to show.
    fittedKey.current = null;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    // A theme switch recolours the axes and the series alike; the series used to keep the old theme's colours.
    const observer = new MutationObserver(() => {
      const n = palette();
      chart.applyOptions({ layout: { textColor: n.text }, grid: { horzLines: { color: n.line } }, crosshair: { vertLine: { color: n.text, labelBackgroundColor: n.primary }, horzLine: { color: n.text, labelBackgroundColor: n.primary } } });
      areaRef.current?.applyOptions({ lineColor: n.primary, topColor: n.primarySoft });
      candleRef.current?.applyOptions({ upColor: n.up, downColor: n.down, borderUpColor: n.up, borderDownColor: n.down, wickUpColor: n.up, wickDownColor: n.down });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      ro.disconnect();
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      areaRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [height, style]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const p = palette();
    if (areaRef.current) areaRef.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    if (candleRef.current) candleRef.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    if (volumeRef.current) {
      const hasVolume = candles.some((c) => c.volume > 0);
      volumeRef.current.setData(hasVolume ? candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? withAlpha(p.up, 0.33, "rgba(22,163,74,0.33)") : withAlpha(p.down, 0.33, "rgba(239,68,68,0.33)") })) : []);
    }
    // Fit once per series; a refresh of the same series must not throw away the reader's zoom.
    if (fittedKey.current !== seriesKey) {
      chart.timeScale().fitContent();
      fittedKey.current = seriesKey;
    }
  }, [candles, style, seriesKey]);

  const zoom = (factor: number) => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    const span = range.to - range.from;
    const center = (range.from + range.to) / 2;
    const next = Math.max(5, span * factor);
    ts.setVisibleLogicalRange({ from: center - next / 2, to: center + next / 2 });
  };

  return (
    <div className="relative">
      <div ref={ref} className="w-full" style={{ height }} role="img" aria-label={style === "candles" ? "Candlestick chart" : "Price chart"} />
      <div className="absolute left-2 bottom-2 flex items-center gap-1 rounded-[6px] border border-line bg-canvas/90 backdrop-blur-[2px] p-0.5" role="group" aria-label="Chart zoom">
        <button type="button" onClick={() => zoom(0.6)} aria-label="Zoom in" className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] text-ink-secondary hover:text-ink hover:bg-surface text-[15px] font-medium">+</button>
        <button type="button" onClick={() => zoom(1.6)} aria-label="Zoom out" className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] text-ink-secondary hover:text-ink hover:bg-surface text-[15px] font-medium">−</button>
        <button type="button" onClick={() => chartRef.current?.timeScale().fitContent()} aria-label="Reset zoom" className="h-7 px-2 inline-flex items-center justify-center rounded-[4px] text-ink-secondary hover:text-ink hover:bg-surface font-mono text-[10px] uppercase tracking-[0.06em]">fit</button>
      </div>
    </div>
  );
}

export default PriceChart;

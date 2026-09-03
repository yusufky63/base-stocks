"use client";

import { useEffect, useRef } from "react";
import { createChart, AreaSeries, CandlestickSeries, HistogramSeries, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "@/domain/market";

export type ChartStyle = "line" | "candles";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * TradingView Lightweight Charts: area (line) or candlesticks, with a volume histogram when the
 * series carries volume (DEX OHLCV). Theme-aware; touch enabled. Reference-feed series (Chainlink
 * rounds) have no volume, so the histogram simply stays hidden for them.
 */
export function PriceChart({ candles, height = 320, style = "line" }: { candles: Candle[]; height?: number; style?: ChartStyle }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const text = cssVar("--text-muted") || "#717886";
    const line = cssVar("--border") || "#dee1e7";
    const primary = cssVar("--primary") || "#0000ff";
    const up = cssVar("--positive") || "#16a34a";
    const down = cssVar("--danger") || "#ef4444";
    const chart = createChart(el, {
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text, fontFamily: "Roboto Mono, ui-monospace, monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: text, width: 1, style: 2, labelBackgroundColor: primary }, horzLine: { color: text, width: 1, style: 2, labelBackgroundColor: primary } },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      // Wheel zooms the time axis (page scroll stays on the rest of the page); pinch on touch; drag the axis to scale.
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: { priceFormatter: (p: number) => `$${p.toFixed(p < 10 ? 4 : 2)}` },
    });
    if (style === "candles") {
      candleRef.current = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        borderUpColor: up,
        borderDownColor: down,
        wickUpColor: up,
        wickDownColor: down,
        priceLineVisible: true,
        lastValueVisible: true,
      });
    } else {
      areaRef.current = chart.addSeries(AreaSeries, {
        lineColor: primary,
        lineWidth: 2,
        topColor: "rgba(0,0,255,0.12)",
        bottomColor: "rgba(0,0,255,0.0)",
        priceLineVisible: true,
        lastValueVisible: true,
        crosshairMarkerRadius: 4,
      });
    }
    volumeRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    const observer = new MutationObserver(() => {
      chart.applyOptions({ layout: { textColor: cssVar("--text-muted") }, grid: { horzLines: { color: cssVar("--border") } } });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
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
    const up = cssVar("--positive") || "#16a34a";
    const down = cssVar("--danger") || "#ef4444";
    if (areaRef.current) areaRef.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    if (candleRef.current) candleRef.current.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    if (volumeRef.current) {
      const hasVolume = candles.some((c) => c.volume > 0);
      volumeRef.current.setData(hasVolume ? candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? `${up}55` : `${down}55` })) : []);
    }
    chart.timeScale().fitContent();
  }, [candles, style]);

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

"use client";

import { useEffect, useRef } from "react";
import { cx } from "@/components/ui/primitives";
import { useMotion } from "@/lib/motion";

interface Props {
  /** Palette; defaults to theme tokens (muted ink, Base Blue, positive). */
  colors?: string[];
  /** Milliseconds between glitch ticks. */
  glitchSpeed?: number;
  smooth?: boolean;
  centerVignette?: boolean;
  outerVignette?: boolean;
  className?: string;
  /** Overall opacity of the character layer. */
  opacity?: number;
}

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%+-=<>/\\|{}[]#*&";
const FONT = 15;
const CW = 10;
const CH = 20;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace("#", "");
  if (m.length === 3) return [parseInt(m[0]! + m[0], 16), parseInt(m[1]! + m[1], 16), parseInt(m[2]! + m[2], 16)];
  if (m.length === 6) return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  return null;
}

/**
 * Letter-glitch backdrop (after reactbits.dev/backgrounds/letter-glitch): a grid of characters that
 * randomly re-roll their glyph and tween between palette colours. Pauses when off-screen or hidden;
 * renders a single static frame under reduced motion.
 */
export function LetterGlitch({ colors, glitchSpeed = 60, smooth = true, centerVignette = false, outerVignette = true, className, opacity = 0.35 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { enabled } = useMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const fallback: [number, number, number] = [113, 120, 134];
    const palette: Array<[number, number, number]> = (colors ?? [cssVar("--text-muted", "#717886"), cssVar("--primary", "#0370fd"), cssVar("--positive", "#66c800")]).map((c) => hexToRgb(c) ?? fallback);
    const reduced = !enabled;

    type Cell = { ch: string; color: [number, number, number]; target: [number, number, number]; t: number };
    let cells: Cell[] = [];
    let cols = 0;
    let rows = 0;
    let raf = 0;
    let last = 0;
    let visible = true;

    const pick = () => palette[Math.floor(Math.random() * palette.length)]!;
    const glyph = () => CHARS[Math.floor(Math.random() * CHARS.length)]!;

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / CW);
      rows = Math.ceil(height / CH);
      cells = Array.from({ length: cols * rows }, () => {
        const c = pick();
        return { ch: glyph(), color: c, target: c, t: 1 };
      });
      draw();
    };

    const font = () => `${FONT}px ${cssVar("--font-mono", "ui-monospace")}, ui-monospace, monospace`;

    const drawCell = (i: number) => {
      const c = cells[i]!;
      const x = (i % cols) * CW;
      const y = Math.floor(i / cols) * CH;
      ctx.clearRect(x, y, CW, CH);
      ctx.fillStyle = `rgb(${c.color[0]},${c.color[1]},${c.color[2]})`;
      ctx.fillText(c.ch, x, y);
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = font();
      ctx.textBaseline = "top";
      for (let i = 0; i < cells.length; i++) drawCell(i);
    };

    // Only cells that changed this tick are repainted (a few percent of the grid), not the whole canvas.
    const dirty = new Set<number>();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.visibilityState === "hidden") return;
      if (now - last < glitchSpeed) return;
      last = now;
      const n = Math.max(1, Math.floor(cells.length * 0.03));
      for (let k = 0; k < n; k++) {
        const i = Math.floor(Math.random() * cells.length);
        const c = cells[i]!;
        c.ch = glyph();
        c.target = pick();
        c.t = smooth ? 0 : 1;
        if (!smooth) c.color = c.target;
        dirty.add(i);
      }
      ctx.font = font();
      ctx.textBaseline = "top";
      for (const i of dirty) {
        const c = cells[i];
        if (!c) continue; // grid was rebuilt smaller (resize) while this index was still queued
        if (smooth && c.t < 1) {
          c.t = Math.min(1, c.t + 0.12);
          const mix = (j: 0 | 1 | 2) => Math.round(c.color[j] + (c.target[j] - c.color[j]) * c.t);
          c.color = [mix(0), mix(1), mix(2)];
        }
        drawCell(i);
        if (c.t >= 1) dirty.delete(i);
      }
    };

    const io = new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)), { threshold: 0.05 });
    io.observe(canvas);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (!reduced) raf = requestAnimationFrame(tick);
    const themeObs = new MutationObserver(resize);
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      themeObs.disconnect();
    };
  }, [colors, glitchSpeed, smooth, enabled]);

  return (
    <div className={cx("absolute inset-0 overflow-hidden pointer-events-none", className)} aria-hidden>
      <canvas ref={canvasRef} className="w-full h-full block" style={{ opacity }} />
      {outerVignette && <div className="absolute inset-0" style={{ background: "radial-gradient(circle at center, transparent 45%, var(--bg) 92%)" }} />}
      {centerVignette && <div className="absolute inset-0" style={{ background: "radial-gradient(circle at center, var(--bg) 0%, transparent 65%)" }} />}
    </div>
  );
}

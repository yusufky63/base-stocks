"use client";

import { useEffect, useRef } from "react";
import { cx } from "@/components/ui/primitives";
import { useMotion } from "@/lib/motion";

interface Props {
  /** Size of one rendered "pixel" in CSS px. */
  pixelSize?: number;
  /** Wave animation speed. */
  speed?: number;
  /** Colour of lit pixels; defaults to Base Blue. */
  color?: string;
  /** Mouse influence radius in pixels (0 disables). */
  mouseRadius?: number;
  /** Alpha of the layer. */
  opacity?: number;
  className?: string;
}

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function noise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function parseColor(c: string): [number, number, number] {
  const m = c.trim().replace("#", "");
  if (/^[0-9a-f]{6}$/i.test(m)) return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
  if (/^[0-9a-f]{3}$/i.test(m)) return [parseInt(m[0]! + m[0], 16), parseInt(m[1]! + m[1], 16), parseInt(m[2]! + m[2], 16)];
  return [0, 0, 255];
}

/**
 * Ordered-dither wave backdrop (after reactbits.dev/backgrounds/dither), implemented on a 2D
 * canvas instead of WebGL: low-res value noise → 4×4 Bayer threshold → nearest-neighbour upscale.
 * Cheap (a few thousand cells), pauses off-screen, static under reduced motion.
 */
export function Dither({ pixelSize = 6, speed = 0.35, color, mouseRadius = 90, opacity = 0.5, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { enabled } = useMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = !enabled;
    const rgb = parseColor(color ?? getComputedStyle(document.documentElement).getPropertyValue("--primary") ?? "#0370fd");
    const off = document.createElement("canvas");
    const octx = off.getContext("2d")!;
    let cols = 0, rows = 0, img: ImageData | null = null, raf = 0, visible = true;
    const mouse = { x: -9999, y: -9999 };
    const start = performance.now();

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      cols = Math.max(1, Math.ceil(width / pixelSize));
      rows = Math.max(1, Math.ceil(height / pixelSize));
      off.width = cols;
      off.height = rows;
      img = octx.createImageData(cols, rows);
      frame(performance.now());
    };

    const frame = (now: number) => {
      if (!img) return;
      const t = ((now - start) / 1000) * speed;
      const data = img.data;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const nx = x / 22, ny = y / 22;
          let v = 0.55 * noise(nx + t * 0.6, ny + t * 0.25) + 0.3 * noise(nx * 2.1 - t * 0.4, ny * 2.1 + t * 0.5) + 0.15 * noise(nx * 4.3 + t, ny * 4.3);
          if (mouseRadius > 0) {
            const dx = x * pixelSize - mouse.x, dy = y * pixelSize - mouse.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < mouseRadius) v += (1 - d / mouseRadius) * 0.45;
          }
          const threshold = (BAYER[y & 3]![x & 3]! + 0.5) / 16;
          const lit = v > threshold + 0.18;
          const i = (y * cols + x) * 4;
          data[i] = rgb[0];
          data[i + 1] = rgb[1];
          data[i + 2] = rgb[2];
          data[i + 3] = lit ? 255 : 0;
        }
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(off, 0, 0, cols, rows, 0, 0, cols * pixelSize, rows * pixelSize);
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.visibilityState === "hidden") return;
      frame(now);
    };

    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
    };
    const onLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };
    const parent = canvas.parentElement ?? canvas;
    parent.addEventListener("mousemove", onMove);
    parent.addEventListener("mouseleave", onLeave);
    const io = new IntersectionObserver((entries) => (visible = entries.some((e) => e.isIntersecting)), { threshold: 0.05 });
    io.observe(canvas);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (!reduced) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      parent.removeEventListener("mousemove", onMove);
      parent.removeEventListener("mouseleave", onLeave);
    };
  }, [pixelSize, speed, color, mouseRadius, enabled]);

  return (
    <div className={cx("absolute inset-0 overflow-hidden pointer-events-none", className)} aria-hidden>
      <canvas ref={canvasRef} className="w-full h-full block" style={{ opacity }} />
    </div>
  );
}

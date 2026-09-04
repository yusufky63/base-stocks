import fs from "node:fs";
import path from "node:path";
import { coinSrc } from "@/lib/coins";

/**
 * Shared pieces for the share cards rendered with next/og (Satori): the site's own fonts,
 * the brand palette, inline assets and the header lockup. Satori rules to keep in mind:
 * every element with more than one child needs display:flex, and a text node must be the
 * only child of its element (build strings with template literals).
 */

type OgFont = { name: string; data: Buffer; weight: 400 | 500 | 700; style: "normal" };

let fontCache: OgFont[] | null = null;

/** Space Grotesk for display text, DM Sans for copy, JetBrains Mono for labels: same as the app. */
export function ogFonts(): OgFont[] {
  if (fontCache) return fontCache;
  const load = (file: string, name: string, weight: 400 | 500 | 700): OgFont => ({
    name,
    data: fs.readFileSync(path.join(process.cwd(), "public/fonts", file)),
    weight,
    style: "normal",
  });
  fontCache = [
    load("SpaceGrotesk-700.ttf", "Space Grotesk", 700),
    load("DMSans-400.ttf", "DM Sans", 400),
    load("DMSans-500.ttf", "DM Sans", 500),
    load("JetBrainsMono-400.ttf", "JetBrains Mono", 400),
  ];
  return fontCache;
}

/** Inline a file under the project root as a data URI; a missing file just drops the image. */
export function dataUri(relative: string): string | null {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), relative)).toString("base64")}`;
  } catch {
    return null;
  }
}

export const OG = {
  blue: "#0370fd",
  ink: "#0a0b0d",
  secondary: "#5b616e",
  muted: "#717886",
  /** Vivid lime for gifts; the deep tone stays for text that needs contrast on white. */
  green: "#66c800",
  greenDeep: "#2f7d00",
  positive: "#2f7d00",
  danger: "#c62a0f",
  border: "#dee1e7",
  surface: "#f8f9fb",
  size: { width: 1200, height: 630 },
  display: "Space Grotesk",
  body: "DM Sans",
  mono: "JetBrains Mono",
} as const;

/**
 * The card every share image is built on, in the same language as the site-wide one: white canvas,
 * a bordered card with two tick brackets, the brand lockup, content on the left and art on the right.
 *
 * `accent` is what tells the cards apart at a glance in a feed. Blue is the product — a stock, the
 * site. Green is a gift: something being handed to you rather than something to buy. That is the
 * whole signal, and it does more work than any label could at thumbnail size.
 */
export function OgCard({ accent = OG.blue, children, art, footer }: { accent?: string; children: React.ReactNode; art?: React.ReactNode; footer?: string }) {
  const mark = dataUri("public/brand/logo-mark-transparent-256.png");
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", padding: 22, background: "#ffffff", fontFamily: OG.body, color: OG.ink }}>
      <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "48px 60px", border: `1px solid ${OG.border}`, borderRadius: 8, background: "#ffffff" }}>
        <div style={{ position: "absolute", top: -1, left: -1, width: 26, height: 26, borderTop: `2px solid ${accent}`, borderLeft: `2px solid ${accent}`, borderTopLeftRadius: 8 }} />
        <div style={{ position: "absolute", bottom: -1, right: -1, width: 26, height: 26, borderBottom: `2px solid ${accent}`, borderRight: `2px solid ${accent}`, borderBottomRightRadius: 8 }} />
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "space-between", gap: 32 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, width: art ? 600 : 1000 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {mark && <img src={mark} alt="" width={40} height={40} style={{ width: 40, height: 40 }} />}
            <div style={{ display: "flex", fontFamily: OG.display, fontSize: 29, fontWeight: 700, letterSpacing: -0.5 }}>
              <span style={{ color: OG.blue }}>Base</span>
              <span>Stocks</span>
            </div>
          </div>
          {children}
        </div>
        {art}
        </div>
        {footer && <div style={{ display: "flex", fontSize: 18, color: OG.muted, marginTop: 18 }}>{footer}</div>}
      </div>
    </div>
  );
}

/** Pill with a coloured dot, as on the site's nav chips. `tone` fills it when the chip is the headline fact. */
export function OgChip({ label, color = OG.blue, filled = false }: { label: string; color?: string; filled?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, height: 42, padding: "0 18px", borderRadius: 999, background: filled ? color : "#ffffff", border: `1px solid ${filled ? color : OG.border}`, fontSize: 19, fontWeight: 500, color: filled ? "#ffffff" : OG.ink }}>
      <div style={{ display: "flex", width: 7, height: 7, borderRadius: 999, background: filled ? "#ffffff" : color }} />
      {label}
    </div>
  );
}

/** The call to action, in the accent colour, with the same arrow the site uses for outbound links. */
export function OgCta({ label, color = OG.blue }: { label: string; color?: string }) {
  return (
    <div style={{ display: "flex", alignSelf: "flex-start", alignItems: "center", gap: 12, height: 54, padding: "0 26px", borderRadius: 999, background: color, color: "#ffffff", fontFamily: OG.display, fontSize: 24, fontWeight: 500 }}>
      <span>{label}</span>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 17 17 7" />
        <path d="M8 7h9v9" />
      </svg>
    </div>
  );
}

/**
 * One to three 3D coins, arranged so a multi-stock package looks like a package rather than a
 * single token with the rest hidden. Tickers with no render simply drop out.
 */
export function OgCoins({ tickers }: { tickers: (string | undefined)[] }) {
  const coins = tickers
    .map((t) => {
      const p = coinSrc(t, "full");
      return p ? dataUri(`public${p}`) : null;
    })
    .filter((s): s is string => s !== null)
    .slice(0, 3);
  if (coins.length === 0) return null;
  // Sizes and offsets per count: one coin sits large and centred, more of them fan out.
  const layout: Record<number, { size: number; pos: { left: number; top: number }[] }> = {
    1: { size: 320, pos: [{ left: 20, top: 20 }] },
    2: { size: 232, pos: [{ left: 0, top: 10 }, { left: 128, top: 130 }] },
    3: { size: 184, pos: [{ left: 4, top: 34 }, { left: 178, top: 0 }, { left: 92, top: 176 }] },
  };
  const { size, pos } = layout[coins.length]!;
  return (
    <div style={{ display: "flex", position: "relative", width: 360, height: 360 }}>
      {coins.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} src={src} alt="" width={size} height={size} style={{ position: "absolute", width: size, height: size, left: pos[i]!.left, top: pos[i]!.top }} />
      ))}
    </div>
  );
}

/**
 * Headline size fitted to the column rather than stepped through guessed brackets.
 *
 * Share labels vary wildly — "0.002 AAPL" against "0.002 AAPL + 0.002 NVDA + 0.002 TSLA" — and a
 * fixed size either wastes the card or orphans a ticker on its own line. Space Grotesk at 700
 * averages close to 0.56em per character at these sizes, which is near enough to pick from.
 */
export function ogHeadlineSize(text: string, maxWidth = 580, max = 66): number {
  if (text.length === 0) return max;
  return Math.max(30, Math.min(max, Math.floor(maxWidth / (text.length * 0.56))));
}

import fs from "node:fs";
import path from "node:path";

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
  positive: "#2f7d00",
  danger: "#c62a0f",
  border: "#dee1e7",
  surface: "#f8f9fb",
  size: { width: 1200, height: 630 },
  display: "Space Grotesk",
  body: "DM Sans",
  mono: "JetBrains Mono",
} as const;

/** Outer frame: white card, blue border, fixed padding, header on top and footer at the bottom. */
export function OgFrame({ children, footer }: { children: React.ReactNode; footer: string }) {
  const mark = dataUri("public/brand/logo-mark-transparent-256.png");
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "56px 64px", background: "#ffffff", color: OG.ink, fontFamily: OG.body, border: `16px solid ${OG.blue}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {mark && <img src={mark} alt="" width={52} height={52} style={{ width: 52, height: 52 }} />}
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>
          <span>B</span>
          <span style={{ color: OG.blue }}>Stocks</span>
        </div>
        <span style={{ fontSize: 20, color: OG.secondary, marginLeft: 10, marginTop: 4 }}>Stocks, built for onchain · Base</span>
      </div>
      {children}
      <div style={{ fontSize: 21, color: OG.muted }}>{footer}</div>
    </div>
  );
}

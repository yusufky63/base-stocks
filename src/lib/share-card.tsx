import { ImageResponse } from "next/og";
import { OG, dataUri, ogFonts } from "@/lib/og";

/** App-style chip: thin border, pill shape, small blue dot — matches the how-it-works nav chips. */
function Chip({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, height: 42, padding: "0 18px", borderRadius: 999, background: "#ffffff", border: `1px solid ${OG.border}`, fontSize: 19, fontWeight: 500, color: OG.ink }}>
      <div style={{ display: "flex", width: 7, height: 7, borderRadius: 999, background: OG.blue }} />
      {label}
    </div>
  );
}

/**
 * The site-wide share card, in the app's own visual language: white canvas, a bordered card with
 * the signature blue tick brackets, a brand lockup, Space Grotesk headline and a cluster of the
 * real stock coins on the right. Static content (no data fetch) so it never fails.
 *
 * Drawn at two sizes: 1200×630 (1.91:1) for Open Graph and Twitter cards, and 1200×800 (3:2) for
 * the Farcaster / Base app embed, whose spec asks for 3:2 and crops anything else.
 */
export function shareCard(size: { width: number; height: number }): ImageResponse {
  const mark = dataUri("public/brand/logo-mark-transparent-256.png");
  const coins = ["nvda", "googl", "tsla"].map((c) => dataUri(`public/brand/coins/${c}.png`)).filter((s): s is string => s !== null);
  const coinPos = [
    { left: 4, top: 34 },
    { left: 178, top: 0 },
    { left: 92, top: 176 },
  ];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", padding: 22, background: "#ffffff", fontFamily: OG.body, color: OG.ink }}>
        {/* Bordered card with blue tick brackets — the app's section frame */}
        <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 32, padding: "56px 60px", border: `1px solid ${OG.border}`, borderRadius: 8, background: "#ffffff" }}>
          {/* tick brackets: top-left + bottom-right */}
          <div style={{ position: "absolute", top: -1, left: -1, width: 26, height: 26, borderTop: `2px solid ${OG.blue}`, borderLeft: `2px solid ${OG.blue}`, borderTopLeftRadius: 8 }} />
          <div style={{ position: "absolute", bottom: -1, right: -1, width: 26, height: 26, borderBottom: `2px solid ${OG.blue}`, borderRight: `2px solid ${OG.blue}`, borderBottomRightRadius: 8 }} />

          {/* Left column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 22, width: 620 }}>
            {/* Brand lockup */}
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {mark && <img src={mark} alt="" width={40} height={40} style={{ width: 40, height: 40 }} />}
              <div style={{ display: "flex", fontFamily: OG.display, fontSize: 29, fontWeight: 700, letterSpacing: -0.5 }}>
                <span style={{ color: OG.blue }}>B</span>
                <span>Stocks</span>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", fontFamily: OG.display, fontSize: 66, fontWeight: 700, letterSpacing: -2.5, lineHeight: 1.0 }}>
              <span>Tokenized Stocks</span>
              <div style={{ display: "flex", gap: 18 }}>
                <span>on</span>
                <span style={{ color: OG.blue }}>Base</span>
              </div>
            </div>

            <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 540, lineHeight: 1.3 }}>
              Trade, build and hold tokenized equities onchain — in your own wallet.
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <Chip label="Self-custodial" />
              <Chip label="Transparent" />
              <Chip label="Fast execution" />
            </div>

            <div style={{ display: "flex", alignSelf: "flex-start", alignItems: "center", gap: 12, marginTop: 6, height: 54, padding: "0 26px", borderRadius: 999, background: OG.blue, color: "#ffffff", fontFamily: OG.display, fontSize: 24, fontWeight: 500 }}>
              <span>basestocks.finance</span>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17 17 7" />
                <path d="M8 7h9v9" />
              </svg>
            </div>
          </div>

          {/* Right: a cluster of real stock coins */}
          <div style={{ display: "flex", position: "relative", width: 360, height: 360 }}>
            {coins.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt="" width={184} height={184} style={{ position: "absolute", width: 184, height: 184, left: coinPos[i]!.left, top: coinPos[i]!.top }} />
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: ogFonts() },
  );
}

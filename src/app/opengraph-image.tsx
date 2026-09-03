import { ImageResponse } from "next/og";
import fs from "node:fs";
import path from "node:path";

export const alt = "BStocks — Coinbase Tokenized Stocks on Base";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Site-wide share card (home, docs, manifest). Static: no data fetch, so it never fails. */
export default function Image() {
  const mark = `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), "public/brand/logo-mark-transparent-256.png")).toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#ffffff", color: "#0a0b0d", fontFamily: "sans-serif", border: "16px solid #0000ff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 28, fontWeight: 700 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={mark} alt="" width={56} height={56} style={{ width: 56, height: 56 }} />
          <span>B</span>
          <span style={{ color: "#0000ff", marginLeft: -12 }}>Stocks</span>
          <span style={{ fontSize: 20, fontWeight: 400, color: "#5b616e", marginLeft: 12 }}>Stocks, built for onchain · Base</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 92, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>Coinbase Tokenized Stocks,</div>
          <div style={{ fontSize: 92, fontWeight: 700, letterSpacing: -4, lineHeight: 1, color: "#0000ff" }}>in your own wallet.</div>
          <div style={{ fontSize: 34, color: "#5b616e", marginTop: 16 }}>Trade · Build baskets · Automate · Earn · Send by Basename</div>
        </div>
        <div style={{ fontSize: 24, color: "#717886" }}>Self-custodial · quotes from Base DEX liquidity · not investment advice</div>
      </div>
    ),
    { ...size },
  );
}

import { ImageResponse } from "next/og";
import fs from "node:fs";
import path from "node:path";
import { coinSrc } from "@/lib/coins";
import { findCuratedAsset } from "@/lib/b20/registry";
import { loadAssetResponse } from "@/lib/server-data";

export const alt = "BStocks";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Dynamic share card: ticker, name, live price and 24h move. */
export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const entry = findCuratedAsset(address);
  const data = entry ? await loadAssetResponse(address) : null;
  const price = data?.price?.displayUsd ?? null;
  const change = data?.price?.marketChange24hPct ?? null;
  const name = data?.asset.name ?? entry?.underlying ?? "Tokenized stock";
  const ticker = entry?.underlying ?? "—";
  const priceText = price !== null ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "";
  const changeText = change !== null ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%` : "";
  const changeColor = change !== null && change < 0 ? "#fc401f" : "#2f7d00";
  const mark = dataUri("public/brand/logo-mark-transparent-256.png");
  const coinPath = coinSrc(entry?.underlying, "full");
  const coin = coinPath ? dataUri(path.join("public", coinPath)) : null;
  return new ImageResponse(
    (
      <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#ffffff", color: "#0a0b0d", fontFamily: "sans-serif", border: "16px solid #0370fd" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {coin && <img src={coin} alt="" width={380} height={380} style={{ position: "absolute", right: 56, top: 125, width: 380, height: 380 }} />}
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 28, fontWeight: 700 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {mark && <img src={mark} alt="" width={56} height={56} style={{ width: 56, height: 56 }} />}
          <span>B</span>
          <span style={{ color: "#0370fd", marginLeft: -12 }}>Stocks</span>
          <span style={{ fontSize: 20, fontWeight: 400, color: "#5b616e", marginLeft: 12 }}>Stocks, built for onchain · Base</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 40, color: "#5b616e" }}>{`${ticker} · Coinbase Tokenized Stock`}</div>
          <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -4, lineHeight: 1 }}>{name}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 24, marginTop: 8 }}>
            <div style={{ fontSize: 96, fontWeight: 700, letterSpacing: -4 }}>{priceText}</div>
            <div style={{ fontSize: 48, fontWeight: 700, color: changeColor }}>{changeText}</div>
          </div>
        </div>
        <div style={{ fontSize: 24, color: "#717886" }}>Self-custodial · quotes from Base DEX liquidity · not investment advice</div>
      </div>
    ),
    { ...size },
  );
}

/** Inline a public asset for Satori; a missing file just drops the image instead of failing the card. */
function dataUri(relative: string): string | null {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), relative)).toString("base64")}`;
  } catch {
    return null;
  }
}

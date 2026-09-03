import { ImageResponse } from "next/og";
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
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#ffffff", color: "#0a0b0d", fontFamily: "sans-serif", border: "16px solid #0370fd" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 28, fontWeight: 700 }}>
          <div style={{ display: "flex", gap: 4 }}>
            <div style={{ width: 14, height: 14, background: "#0a0b0d", opacity: 0.55, marginTop: 20 }} />
            <div style={{ width: 14, height: 14, background: "#0a0b0d", opacity: 0.8, marginTop: 10 }} />
            <div style={{ width: 14, height: 14, background: "#0370fd" }} />
          </div>
          <span>B</span>
          <span style={{ color: "#0370fd", marginLeft: -12 }}>Stocks</span>
          <span style={{ fontSize: 20, fontWeight: 400, color: "#5b616e", marginLeft: 12 }}>Stocks, built for onchain · Base</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 40, color: "#5b616e" }}>{ticker} · Coinbase Tokenized Stock</div>
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

import { ImageResponse } from "next/og";
import path from "node:path";
import { coinSrc } from "@/lib/coins";
import { OG, OgFrame, dataUri, ogFonts } from "@/lib/og";
import { findCuratedAsset } from "@/lib/b20/registry";
import { loadAssetResponse } from "@/lib/server-data";

export const alt = "BStocks";
export const size = OG.size;
export const contentType = "image/png";

/** Dynamic share card: ticker, name, live price, 24h move and the 3D coin when one exists. */
export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const entry = findCuratedAsset(address);
  const data = entry ? await loadAssetResponse(address).catch(() => null) : null;
  const price = data?.price?.displayUsd ?? null;
  const change = data?.price?.marketChange24hPct ?? null;
  const name = data?.asset.name ?? entry?.underlying ?? "Tokenized stock";
  const ticker = entry?.underlying ?? "—";
  const priceText = price !== null ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not issued yet";
  const changeText = change !== null ? `${change > 0 ? "+" : ""}${change.toFixed(2)}% today` : "";
  const changeColor = change !== null && change < 0 ? OG.danger : OG.positive;
  const coinPath = coinSrc(entry?.underlying, "full");
  const coin = coinPath ? dataUri(path.join("public", coinPath)) : null;
  const nameSize = name.length > 22 ? 54 : name.length > 14 ? 64 : 76;
  const priceSize = price !== null ? 96 : 56;
  return new ImageResponse(
    (
      <OgFrame footer="Self-custodial · quotes from Base DEX liquidity · not investment advice">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, width: coin ? 676 : 1040 }}>
            <div style={{ fontFamily: OG.mono, fontSize: 22, letterSpacing: 2, textTransform: "uppercase", color: OG.secondary }}>{`${ticker} · Coinbase Tokenized Stock`}</div>
            <div style={{ fontFamily: OG.display, fontSize: nameSize, fontWeight: 700, letterSpacing: -1.5, lineHeight: 1.05 }}>{name}</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 22, marginTop: 6 }}>
              <div style={{ fontFamily: OG.display, fontSize: priceSize, fontWeight: 700, letterSpacing: -3, lineHeight: 1 }}>{priceText}</div>
              {changeText && <div style={{ fontSize: 38, fontWeight: 500, color: changeColor, paddingBottom: 10 }}>{changeText}</div>}
            </div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {coin && <img src={coin} alt="" width={340} height={340} style={{ width: 340, height: 340 }} />}
        </div>
      </OgFrame>
    ),
    { ...size, fonts: ogFonts() },
  );
}

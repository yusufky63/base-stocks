import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, hasCoinArt, ogFonts } from "@/lib/og";
import { findCuratedAsset } from "@/lib/b20/registry";
import { loadAssetResponse } from "@/lib/server-data";

export const alt = "BStocks";
export const size = OG.size;
export const contentType = "image/png";

/** Dynamic share card: ticker, name, live price and the 24h move. Blue — this one is the product. */
export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const entry = findCuratedAsset(address);
  const data = entry ? await loadAssetResponse(address).catch(() => null) : null;
  const price = data?.price?.displayUsd ?? null;
  const change = data?.price?.marketChange24hPct ?? null;
  const name = data?.asset.name ?? entry?.underlying ?? "Tokenized stock";
  const ticker = entry?.underlying ?? null;
  const priceText = price !== null ? `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Not issued yet";
  const changeText = change !== null ? `${change > 0 ? "+" : ""}${change.toFixed(2)}% today` : null;
  const nameSize = name.length > 22 ? 46 : name.length > 14 ? 56 : 66;
  return new ImageResponse(
    (
      <OgCard footer="Self-custodial · quotes from Base DEX liquidity · not investment advice" art={hasCoinArt([entry?.underlying]) ? <OgCoins tickers={[entry?.underlying]} /> : undefined}>
        <div style={{ display: "flex", gap: 12 }}>
          {ticker && <OgChip label={ticker} filled />}
          <OgChip label="Coinbase Tokenized Stock" />
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: nameSize, fontWeight: 700, letterSpacing: -2, lineHeight: 1.0 }}>{name}</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 20 }}>
          <div style={{ display: "flex", fontFamily: OG.display, fontSize: price !== null ? 76 : 46, fontWeight: 700, letterSpacing: -3, lineHeight: 1, color: OG.blue }}>{priceText}</div>
          {changeText && <div style={{ display: "flex", fontSize: 30, fontWeight: 500, paddingBottom: 8, color: change !== null && change < 0 ? OG.danger : OG.greenDeep }}>{changeText}</div>}
        </div>
        <OgCta label="basestocks.finance" />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

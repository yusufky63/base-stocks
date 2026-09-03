import { ImageResponse } from "next/og";
import { OG, OgFrame, dataUri, ogFonts } from "@/lib/og";

export const alt = "BStocks — Coinbase Tokenized Stocks on Base";
export const size = OG.size;
export const contentType = "image/png";

/** Site-wide share card (home, docs, manifest). Static: no data fetch, so it never fails. */
export default function Image() {
  const coins = ["aapl", "meta", "nvda"].map((c) => dataUri(`public/brand/coins/${c}.png`)).filter((c): c is string => c !== null);
  return new ImageResponse(
    (
      <OgFrame footer="Self-custodial · quotes from Base DEX liquidity · not investment advice">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20, width: 660 }}>
            <div style={{ display: "flex", flexDirection: "column", fontFamily: OG.display, fontSize: 66, fontWeight: 700, letterSpacing: -2, lineHeight: 1.04 }}>
              <span>Coinbase Tokenized</span>
              <span>Stocks,</span>
              <span style={{ color: OG.blue }}>in your own wallet.</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 500, color: OG.secondary }}>Trade · Baskets · Automate · Earn · Send by Basename</div>
          </div>
          {coins.length > 0 && (
            <div style={{ display: "flex", position: "relative", width: 330, height: 330 }}>
              {coins.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={src} alt="" width={200} height={200} style={{ position: "absolute", width: 190, height: 190, left: [130, 0, 70][i], top: [0, 50, 140][i] }} />
              ))}
            </div>
          )}
        </div>
      </OgFrame>
    ),
    { ...size, fonts: ogFonts() },
  );
}

import { ImageResponse } from "next/og";
import path from "node:path";
import { coinSrc } from "@/lib/coins";
import { OG, OgFrame, dataUri, ogFonts } from "@/lib/og";
import { getGiftReceipt, giftAmountLabel, giftPartyLabel } from "@/services/gift-service";

export const alt = "A gift on BStocks";
export const size = OG.size;
export const contentType = "image/png";

/** Share card for a claim-link gift: who sent what, with the 3D coin. No secret is ever in here. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getGiftReceipt(id).catch(() => null);
  const amount = r ? giftAmountLabel(r) : "A tokenized stock";
  const sender = r ? giftPartyLabel(r.sender) : "Someone";
  const coinPath = coinSrc(r?.asset?.underlying, "full");
  const coin = coinPath ? dataUri(path.join("public", coinPath)) : null;
  return new ImageResponse(
    (
      <OgFrame footer="Open the link to claim · a passkey wallet takes seconds · not investment advice">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, width: coin ? 676 : 1040 }}>
            <div style={{ fontFamily: OG.mono, fontSize: 22, letterSpacing: 2, textTransform: "uppercase", color: OG.secondary }}>{`Gift · from ${sender}`}</div>
            <div style={{ fontFamily: OG.display, fontSize: 84, fontWeight: 700, letterSpacing: -2, lineHeight: 1.02 }}>A gift for you</div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
              <div style={{ display: "flex", fontFamily: OG.display, fontSize: 54, fontWeight: 700, letterSpacing: -1, color: OG.blue }}>{amount}</div>
            </div>
            <div style={{ fontSize: 26, color: OG.secondary, marginTop: 2 }}>A Coinbase Tokenized Stock on Base. No wallet needed.</div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {coin && <img src={coin} alt="" width={340} height={340} style={{ width: 340, height: 340 }} />}
        </div>
      </OgFrame>
    ),
    { ...size, fonts: ogFonts() },
  );
}

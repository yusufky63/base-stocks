import { ImageResponse } from "next/og";
import path from "node:path";
import { coinSrc } from "@/lib/coins";
import { OG, OgFrame, dataUri, ogFonts } from "@/lib/og";
import { getPoolView } from "@/services/pool-service";
import { formatTokenAmount } from "@/lib/format";

export const alt = "A gift pool on BStocks";
export const size = OG.size;
export const contentType = "image/png";

/** Share card for a pool: the share everyone gets and how many are left. No secret is ever here. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getPoolView(id).catch(() => null);
  const share = view && view.legs.length > 0 ? view.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ") : "A tokenized stock";
  const remaining = view?.onchain?.remainingSlots ?? view?.pool.slots ?? 0;
  const slots = view?.pool.slots ?? 0;
  const coinPath = coinSrc(view?.legs[0]?.underlying, "full");
  const coin = coinPath ? dataUri(path.join("public", coinPath)) : null;

  return new ImageResponse(
    (
      <OgFrame footer="One share per wallet · a passkey wallet takes seconds · not investment advice">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, width: coin ? 676 : 1040 }}>
            <div style={{ fontFamily: OG.mono, fontSize: 22, letterSpacing: 2, textTransform: "uppercase", color: OG.secondary }}>
              {slots > 0 ? `Gift pool · ${remaining} of ${slots} left` : "Gift pool"}
            </div>
            <div style={{ fontFamily: OG.display, fontSize: 78, fontWeight: 700, letterSpacing: -2, lineHeight: 1.02 }}>
              {view?.pool.title || "Claim your share"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
              <div style={{ display: "flex", fontFamily: OG.display, fontSize: 52, fontWeight: 700, letterSpacing: -1, color: OG.blue }}>{share} each</div>
            </div>
            <div style={{ fontSize: 26, color: OG.secondary, marginTop: 2 }}>Coinbase Tokenized Stocks on Base. No wallet needed.</div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {coin && <img src={coin} alt="" width={340} height={340} style={{ width: 340, height: 340 }} />}
        </div>
      </OgFrame>
    ),
    { ...size, fonts: ogFonts() },
  );
}

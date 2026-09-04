import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, ogFonts, ogHeadlineSize } from "@/lib/og";
import { getGiftReceipt, giftAmountLabel, giftPartyLabel } from "@/services/gift-service";

export const alt = "A gift on BStocks";
export const size = OG.size;
export const contentType = "image/png";

/**
 * Share card for a claim-link gift.
 *
 * Green throughout, because this card is not selling anything — someone is handing the reader a
 * share of a company. The amount is the headline for the same reason: it is the gift, and a title
 * above it would only push it down the card. No secret is ever in here; the claim key lives in the
 * URL fragment, which never reaches this server.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getGiftReceipt(id).catch(() => null);
  const amount = r ? giftAmountLabel(r) : "A tokenized stock";
  const sender = r ? giftPartyLabel(r.sender) : null;
  return new ImageResponse(
    (
      <OgCard accent={OG.green} footer="Self-custodial from the moment you claim · not investment advice" art={<OgCoins tickers={[r?.asset?.underlying]} />}>
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label="A gift for you" color={OG.green} filled />
          {sender && <OgChip label={`from ${sender}`} color={OG.green} />}
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: ogHeadlineSize(amount), fontWeight: 700, letterSpacing: -2, lineHeight: 1.0, color: OG.greenDeep }}>{amount}</div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          A Coinbase Tokenized Stock on Base, yours to hold. No wallet needed — a passkey takes seconds.
        </div>
        <OgCta label="Open the link to claim" color={OG.green} />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

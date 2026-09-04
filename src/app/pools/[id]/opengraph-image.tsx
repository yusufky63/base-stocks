import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, hasCoinArt, ogFonts, ogHeadlineSize } from "@/lib/og";
import { getPoolView } from "@/services/pool-service";
import { formatTokenAmount } from "@/lib/format";

export const alt = "A gift pool on BStocks";
export const size = OG.size;
export const contentType = "image/png";

/**
 * Share card for a gift pool: what each person gets, and how many shares are still there.
 *
 * The share is the headline rather than the pool's title — a title is whatever the creator typed,
 * while the share is the reason to click. Every leg gets its own coin so a multi-stock package
 * looks like one. No secret is ever here.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getPoolView(id).catch(() => null);
  const share = view && view.legs.length > 0 ? view.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ") : "A tokenized stock";
  const remaining = view?.onchain?.remainingSlots ?? view?.pool.slots ?? 0;
  const slots = view?.pool.slots ?? 0;
  const legTickers = (view?.legs ?? []).map((l) => l.underlying);
  const soldOut = slots > 0 && remaining === 0;
  return new ImageResponse(
    (
      <OgCard accent={OG.green} footer="One share per wallet · a passkey wallet takes seconds · not investment advice" art={hasCoinArt(legTickers) ? <OgCoins tickers={legTickers} /> : undefined}>
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label="Gift pool" color={OG.green} filled />
          {slots > 0 && <OgChip label={soldOut ? "All shares claimed" : `${remaining} of ${slots} left`} color={OG.green} />}
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: ogHeadlineSize(share), fontWeight: 700, letterSpacing: -2, lineHeight: 1.0, color: OG.greenDeep }}>{share}</div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          {view?.pool.title ? `${view.pool.title} — one share per wallet, on Base.` : "That much for each person, one share per wallet. Coinbase Tokenized Stocks on Base."}
        </div>
        <OgCta label={soldOut ? "See the pool" : "Claim your share"} color={OG.green} />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, OgLegs, hasCoinArt, ogFonts, ogHeadlineSize } from "@/lib/og";
import { getPoolView } from "@/services/pool-service";
import { formatTokenAmount } from "@/lib/format";

export const alt = "A gift pool on BaseStocks";
export const size = OG.size;
export const contentType = "image/png";

/**
 * Share card for a gift pool: what each person gets, and how many shares are still there.
 *
 * One or two stocks read as a sentence, and the headline says them outright. A package of more
 * cannot: "0.002 AAPL + 0.002 NVDA + 0.002 TSLA + …" wraps three lines deep, repeats the same
 * amount over and over, and still leaves most of the package unnamed because only three coins fit.
 * Past two legs the headline says how many there are and the legs move to the right, where each
 * one is actually named. No secret is ever here.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await getPoolView(id).catch(() => null);
  const legs = (view?.legs ?? []).map((l) => ({ underlying: l.underlying, amount: formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals) }));
  const remaining = view?.onchain?.remainingSlots ?? view?.pool.slots ?? 0;
  const slots = view?.pool.slots ?? 0;
  const soldOut = slots > 0 && remaining === 0;

  const isPackage = legs.length > 2;
  const share = legs.length > 0 ? legs.map((l) => `${l.amount} ${l.underlying}`).join(" + ") : "A tokenized stock";
  const headline = isPackage ? `${legs.length} stocks, one claim` : share;
  const tickers = legs.map((l) => l.underlying);

  return new ImageResponse(
    (
      <OgCard
        accent={OG.gift}
        footer="One share per wallet · a passkey wallet takes seconds · not investment advice"
        art={isPackage ? <OgLegs legs={legs} accent={OG.giftDeep} /> : hasCoinArt(tickers) ? <OgCoins tickers={tickers} /> : undefined}
      >
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label="Gift pool" color={OG.gift} filled />
          {slots > 0 && <OgChip label={soldOut ? "All shares claimed" : `${remaining} of ${slots} left`} color={OG.gift} />}
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: ogHeadlineSize(headline), fontWeight: 700, letterSpacing: -2, lineHeight: 1.0, color: OG.giftDeep }}>{headline}</div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          {view?.pool.title?.trim()
            ? `${view.pool.title.trim()} — one share per wallet, on Base.`
            : isPackage
              ? "Every one of them, to each person who claims. Coinbase Tokenized Stocks on Base."
              : "That much for each person, one share per wallet. Coinbase Tokenized Stocks on Base."}
        </div>
        <OgCta label={soldOut ? "See the pool" : "Claim your share"} color={OG.gift} />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

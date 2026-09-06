import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, OgWeights, allocationSummary, hasCoinArt, allocationTickers, ogFonts, ogHeadlineSize } from "@/lib/og";
import { getRepos } from "@/db/repositories";

export const alt = "A basket on BaseStocks";
export const size = OG.size;
export const contentType = "image/png";

/**
 * Share card for a community basket: its name and the mix behind it.
 *
 * The mix is the sub-line rather than the description, because the description is optional and the
 * weights are the thing being shared — a basket is its allocation. Blue: this one is the product.
 */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await getRepos().baskets.get(id).catch(() => null);
  const name = b?.name ?? "A basket of tokenized stocks";
  const mix = b ? allocationSummary(b.allocations) : null;
  const tickers = b ? allocationTickers(b.allocations).slice(0, 3).map((t) => t.ticker) : [];
  // The mix belongs on the card once. With coins on the right it has to be said in words; with the
  // weight bars there it is already drawn, and repeating it would just crowd the line.
  const coins = hasCoinArt(tickers);
  return new ImageResponse(
    (
      <OgCard footer="Copy it into your own wallet · self-custodial · not investment advice" art={coins ? <OgCoins tickers={tickers} /> : <OgWeights allocations={b?.allocations ?? []} />}>
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label="Community basket" filled />
          {b !== null && b.clones > 0 && <OgChip label={`${b.clones} ${b.clones === 1 ? "copy" : "copies"}`} />}
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: ogHeadlineSize(name), fontWeight: 700, letterSpacing: -2, lineHeight: 1.0 }}>{name}</div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          {(coins ? mix : null) || b?.description?.trim() || "Tokenized stocks on Base, in one allocation."}
        </div>
        <OgCta label="Copy this basket" />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

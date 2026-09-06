import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, OgWeights, allocationSummary, hasCoinArt, allocationTickers, ogFonts, ogHeadlineSize } from "@/lib/og";
import { getRepos } from "@/db/repositories";

export const alt = "A portfolio template on BaseStocks";
export const size = OG.size;
export const contentType = "image/png";

/** Share card for a build template: the name, the mix it buys, and how many stocks that is. */
export default async function Image({ params }: { params: Promise<{ template: string }> }) {
  const { template } = await params;
  const t = await getRepos().templates.getBySlug(template).catch(() => null);
  const name = t?.name ?? "A portfolio template";
  const mix = t ? allocationSummary(t.allocations) : null;
  const parts = t ? allocationTickers(t.allocations) : [];
  const coinTickers = parts.slice(0, 3).map((p) => p.ticker);
  // See the basket card: the allocation is stated in words or drawn as bars, never both.
  const coins = hasCoinArt(coinTickers);
  return new ImageResponse(
    (
      <OgCard footer="Built in one batch, confirmed in your wallet · not investment advice" art={coins ? <OgCoins tickers={coinTickers} /> : <OgWeights allocations={t?.allocations ?? []} />}>
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label="Portfolio template" filled />
          {parts.length > 0 && <OgChip label={`${parts.length} stocks`} />}
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: ogHeadlineSize(name), fontWeight: 700, letterSpacing: -2, lineHeight: 1.0 }}>{name}</div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          {(coins ? mix : null) || t?.description?.trim() || "A ready allocation of tokenized stocks on Base."}
        </div>
        <OgCta label="Build this portfolio" />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

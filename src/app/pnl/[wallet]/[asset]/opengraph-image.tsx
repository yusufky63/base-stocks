import { ImageResponse } from "next/og";
import { getAddress, isAddress } from "viem";
import { OG, OgCard, OgChip, OgCoins, OgCta, hasCoinArt, ogFonts } from "@/lib/og";
import { getSharedReturn } from "@/services/pnl-service";

export const alt = "A return on BStocks";
export const size = OG.size;
export const contentType = "image/png";
/** A snapshot like every other card; the figures are shared-cached for five minutes as well. */
export const revalidate = 300;

const usd = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The return card: ticker, percentage and the two per-share prices behind it. Green or red is the
 * only thing that changes with the result. No dollar amount, no share count, no address: the card
 * travels far beyond the person who posted it. A link with nothing behind it (no purchase recorded
 * here, a stock that is not listed) gets the plain brand card rather than an error.
 */
export default async function Image({ params }: { params: Promise<{ wallet: string; asset: string }> }) {
  const { wallet, asset } = await params;
  const r = isAddress(wallet) ? await getSharedReturn(getAddress(wallet), asset).catch(() => null) : null;

  if (!r) {
    return new ImageResponse(
      (
        <OgCard footer="Self-custodial · tokenized stocks on Base · not investment advice">
          <div style={{ display: "flex", fontFamily: OG.display, fontSize: 66, fontWeight: 700, letterSpacing: -2, lineHeight: 1.0 }}>Tokenized stocks on Base</div>
          <OgCta label="basestocks.finance" />
        </OgCard>
      ),
      { ...size, fonts: ogFonts() },
    );
  }

  const up = r.returnPct >= 0;
  const color = up ? OG.greenDeep : OG.danger;
  const pct = `${up ? "+" : "−"}${Math.abs(r.returnPct).toFixed(1)}%`;
  return new ImageResponse(
    (
      <OgCard accent={color} footer="Return on shares bought on BStocks, at today's price · not investment advice" art={hasCoinArt([r.underlying]) ? <OgCoins tickers={[r.underlying]} /> : undefined}>
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label={r.underlying} filled />
          <OgChip label="Coinbase Tokenized Stock" />
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: 118, fontWeight: 700, letterSpacing: -4, lineHeight: 1, color }}>{pct}</div>
        <div style={{ display: "flex", gap: 36, fontSize: 26, color: OG.secondary }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 17, letterSpacing: 1.5, textTransform: "uppercase" }}>Average cost</span>
            <span style={{ color: OG.ink, fontWeight: 500 }}>{`${usd(r.avgCostPerShare)} / share`}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 17, letterSpacing: 1.5, textTransform: "uppercase" }}>Now</span>
            <span style={{ color: OG.ink, fontWeight: 500 }}>{`${usd(r.pricePerShare)} / share`}</span>
          </div>
        </div>
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

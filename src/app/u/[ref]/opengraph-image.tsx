import { ImageResponse } from "next/og";
import { OG, OgCard, OgChip, OgCoins, OgCta, allocationTickers, hasCoinArt, ogFonts, ogHeadlineSize } from "@/lib/og";
import { getRepos } from "@/db/repositories";
import { resolveProfileRef } from "@/services/community-service";
import { reverseResolve } from "@/services/basename-service";
import { shortenAddress } from "@/lib/format";

export const alt = "A profile on BaseStocks";
export const size = OG.size;
export const contentType = "image/png";

/**
 * Share card for a public profile: who they are and what they have published.
 *
 * Deliberately not their holdings. The page shows an allocation for a public profile, but reading
 * it needs a full portfolio snapshot — too slow for a crawler that will not wait — and a card is
 * passed around far beyond the person who opened the link. Published baskets are already public by
 * the act of publishing them, so those are what this counts, and the bio only appears when the
 * profile is public.
 */
export default async function Image({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const address = await resolveProfileRef(ref).catch(() => null);
  const repos = getRepos();
  const [profile, baskets, basename] = address
    ? await Promise.all([
        repos.profiles.get(address).catch(() => null),
        repos.baskets.listByOwner(address).catch(() => []),
        reverseResolve(address).catch(() => null),
      ])
    : [null, [], null];

  const isPublic = profile?.isPublic ?? true;
  const name = basename ?? (address ? shortenAddress(address, 4) : "A BaseStocks profile");
  const bio = isPublic ? profile?.bio?.trim() : undefined;
  // Coins come from what they published, never from what they hold.
  const tickers = allocationTickers(baskets.flatMap((b) => b.allocations)).slice(0, 3).map((t) => t.ticker);

  return new ImageResponse(
    (
      <OgCard footer="Public profile · holdings stay private unless shared · not investment advice" art={hasCoinArt(tickers) ? <OgCoins tickers={tickers} /> : undefined}>
        <div style={{ display: "flex", gap: 12 }}>
          <OgChip label="Profile" filled />
          {baskets.length > 0 && <OgChip label={`${baskets.length} published ${baskets.length === 1 ? "basket" : "baskets"}`} />}
        </div>
        <div style={{ display: "flex", fontFamily: OG.display, fontSize: ogHeadlineSize(name), fontWeight: 700, letterSpacing: -2, lineHeight: 1.0 }}>{name}</div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          {bio || "Building portfolios of tokenized stocks on Base."}
        </div>
        <OgCta label="basestocks.finance" />
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}

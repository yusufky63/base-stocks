import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPoolView } from "@/services/pool-service";
import { formatTokenAmount } from "@/lib/format";
import { PoolClaimView } from "@/components/pool/PoolClaimView";
import type { PoolView } from "@/domain/pool";
import { appMeta, appUrl } from "@/lib/miniapp";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

function shareLabel(view: PoolView): string {
  if (view.legs.length === 0) return "a tokenized stock";
  return view.legs.map((l) => `${formatTokenAmount(BigInt(l.scaledPerClaim), l.decimals)} ${l.underlying}`).join(" + ");
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const view = await getPoolView(id).catch(() => null);
  if (!view) return { title: "Gift pool", robots: { index: false } };
  const title = view.pool.title || `${shareLabel(view)} for each of ${view.pool.slots}`;
  const description = `A gift pool on BaseStocks: ${shareLabel(view)} per person, ${view.pool.slots} shares. Coinbase Tokenized Stocks on Base — no wallet needed to claim.`;
  // Unlisted pools stay out of search results; the link is the only way in by design.
  const robots = view.pool.visibility === "public" ? undefined : { index: false };
  // A launch card that opens *this pool* rather than the home page — but only where the bare URL
  // is enough to claim from. A link-gated pool carries its key in the fragment, which no server
  // and no embed tag ever sees, so a card for one would launch a page that cannot claim. Those
  // keep the site-wide card inherited from the layout, which is at least honest about where it goes.
  const launchable = view.pool.gateMode !== "link";
  const other = launchable
    ? appMeta({ url: appUrl(`/pools/${id}`), imageUrl: appUrl(`/pools/${id}/opengraph-image`), buttonTitle: view.claimCount < view.pool.slots ? "Claim your share" : "See the pool" })
    : undefined;
  return { title, description, robots, openGraph: { title: `${title} · BaseStocks`, description }, ...(other ? { other } : {}) };
}

/**
 * Claim page for a gift pool. A link-gated pool carries its key in the URL fragment, which the
 * browser never sends here — this page renders the same for everyone and the key is used
 * client-side only.
 */
export default async function PoolPage({ params }: Props) {
  const { id } = await params;
  const view = await getPoolView(id).catch(() => null);
  if (!view) notFound();
  return <PoolClaimView initialView={view} />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StockDetailView } from "@/components/stock/StockDetailView";
import { loadAssetResponse } from "@/lib/server-data";
import { CURATED_B20_ASSETS, findCuratedAsset } from "@/lib/b20/registry";
import { Skeleton } from "@/components/ui/primitives";
import { pageMeta } from "@/lib/page-meta";

/** Rendered at most every 30 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 30;

/** The curated stocks are known at build time; each gets a prerendered page that ISR keeps fresh. Discovered ones render on demand. */
export function generateStaticParams() {
  return CURATED_B20_ASSETS.map((a) => ({ address: a.address }));
}

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const entry = findCuratedAsset(address);
  if (!entry) return { title: "Stock" };
  return pageMeta({
    title: `${entry.underlying} · Trade`,
    description: `${entry.underlying} as a Coinbase Tokenized Stock on Base: live pool price, Chainlink reference, liquidity and a self-custodial buy or sell from your own wallet.`,
    // One address, one page: the checksummed form is the canonical one whatever casing the link carried.
    path: `/stocks/${entry.address}`,
  });
}

/** Canonical routing by contract address (spec §41). */
export default async function StockPage({ params }: Props) {
  const { address } = await params;
  if (!findCuratedAsset(address)) notFound();
  const data = await loadAssetResponse(address);
  if (!data) notFound();
  return (
    <Suspense fallback={<Skeleton className="h-[480px]" />}>
      <StockDetailView initialData={data} />
    </Suspense>
  );
}

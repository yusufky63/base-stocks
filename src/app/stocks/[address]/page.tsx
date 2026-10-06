import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StockDetailView } from "@/components/stock/StockDetailView";
import { loadAssetResponse } from "@/lib/server-data";
import { findCuratedAsset } from "@/lib/b20/registry";
import { Skeleton } from "@/components/ui/primitives";
import { ensureDiscoveredRegistry } from "@/services/b20-asset-service";
import { pageMeta } from "@/lib/page-meta";

/**
 * Rendered per request. As an ISR page, any path not prerendered (a discovered stock, a link in
 * another casing) rendered on its first visit as a static page, and a provider read that missed
 * its cache there is an uncached fetch, which Next refuses with "Page changed from static to
 * dynamic at runtime": /stocks/<PLTRc in lowercase> answered 500 on every visit (2026-10-06). The
 * data underneath is cached in the shared store either way, so a request costs a few cache reads.
 */
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  await ensureDiscoveredRegistry();
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
  // Discovered stocks live in storage; a cold instance has to load them before it can say "unknown".
  await ensureDiscoveredRegistry();
  if (!findCuratedAsset(address)) notFound();
  const data = await loadAssetResponse(address);
  if (!data) notFound();
  return (
    <Suspense fallback={<Skeleton className="h-[480px]" />}>
      <StockDetailView initialData={data} />
    </Suspense>
  );
}

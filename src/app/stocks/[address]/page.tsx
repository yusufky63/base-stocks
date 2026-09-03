import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StockDetailView } from "@/components/stock/StockDetailView";
import { loadAssetResponse } from "@/lib/server-data";
import { findCuratedAsset } from "@/lib/b20/registry";
import { Skeleton } from "@/components/ui/primitives";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const entry = findCuratedAsset(address);
  return { title: entry ? `${entry.underlying} · Trade` : "Stock" };
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

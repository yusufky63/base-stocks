import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbedShell } from "@/components/embed/EmbedShell";
import { StockWidget } from "@/components/embed/StockWidget";
import { findCuratedAsset } from "@/lib/b20/registry";
import { parseEmbedAccent, parseEmbedEligibility, parseEmbedHide, parseEmbedRange } from "@/lib/embed";
import { loadAssetResponse } from "@/lib/server-data";

export const metadata: Metadata = { title: "Stock widget" };

type Props = { params: Promise<{ address: string }>; searchParams: Promise<{ range?: string; eligibility?: string; hide?: string; accent?: string }> };

/** A stock's price, daily move and chart for another site's iframe. */
export default async function EmbedStockPage({ params, searchParams }: Props) {
  const [{ address }, { range, eligibility, hide, accent }] = await Promise.all([params, searchParams]);
  if (!findCuratedAsset(address)) notFound();
  const data = await loadAssetResponse(address);
  if (!data) notFound();
  return (
    <EmbedShell widget="stock" eligibility={parseEmbedEligibility(eligibility)} hide={parseEmbedHide(hide)} accent={parseEmbedAccent(accent)}>
      <StockWidget address={data.asset.address} initialData={data} range={parseEmbedRange(range)} />
    </EmbedShell>
  );
}

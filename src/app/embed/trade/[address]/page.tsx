import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmbedShell } from "@/components/embed/EmbedShell";
import { TradeWidget } from "@/components/embed/TradeWidget";
import { findCuratedAsset } from "@/lib/b20/registry";
import { parseEmbedAccent, parseEmbedEligibility, parseEmbedHide, parseEmbedSide } from "@/lib/embed";
import { loadAssetResponse } from "@/lib/server-data";

export const metadata: Metadata = { title: "Trade widget" };

type Props = { params: Promise<{ address: string }>; searchParams: Promise<{ side?: string; eligibility?: string; hide?: string; accent?: string }> };

/** The stock's buy / sell panel for another site's iframe; the same stocks the stock pages serve. */
export default async function EmbedTradePage({ params, searchParams }: Props) {
  const [{ address }, { side, eligibility, hide, accent }] = await Promise.all([params, searchParams]);
  if (!findCuratedAsset(address)) notFound();
  const data = await loadAssetResponse(address);
  if (!data) notFound();
  return (
    <EmbedShell widget="trade" eligibility={parseEmbedEligibility(eligibility)} hide={parseEmbedHide(hide)} accent={parseEmbedAccent(accent)}>
      <TradeWidget address={data.asset.address} initialData={data} initialSide={parseEmbedSide(side)} />
    </EmbedShell>
  );
}

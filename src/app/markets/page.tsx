import type { Metadata } from "next";
import { MarketsView } from "@/components/markets/MarketsView";
import { loadAssetsResponse } from "@/lib/server-data";

export const metadata: Metadata = { title: "Markets" };

export default async function MarketsPage() {
  const initialData = await loadAssetsResponse();
  return <MarketsView initialData={initialData ?? undefined} />;
}

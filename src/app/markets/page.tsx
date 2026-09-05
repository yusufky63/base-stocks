import type { Metadata } from "next";
import { MarketsView } from "@/components/markets/MarketsView";
import { loadAssetsResponse } from "@/lib/server-data";

/** Rendered at most every 30 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 30;

export const metadata: Metadata = { title: "Markets" };

export default async function MarketsPage() {
  const initialData = await loadAssetsResponse();
  return <MarketsView initialData={initialData ?? undefined} />;
}

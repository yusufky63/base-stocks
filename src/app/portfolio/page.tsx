import type { Metadata } from "next";
import { Suspense } from "react";
import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { loadTemplates } from "@/lib/server-data";
import { Skeleton } from "@/components/ui/primitives";

/** Rendered at most every 60 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 60;

export const metadata: Metadata = { title: "Portfolio" };

/** Tabs live in the URL (`?tab=rebalance`), so the view reads search params and needs a boundary. */
export default async function PortfolioPage() {
  const templates = await loadTemplates();
  return (
    <Suspense fallback={<Skeleton className="h-[480px]" />}>
      <PortfolioView initialTemplates={templates} />
    </Suspense>
  );
}

import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { Suspense } from "react";
import { BuildView } from "@/components/build/BuildView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";
import { loadAssetsResponse, loadTemplates } from "@/lib/server-data";
import { Skeleton } from "@/components/ui/primitives";

/** Rendered at most every 60 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 60;

export const metadata: Metadata = pageMeta({ title: "Build", path: "/build" });

export default async function BuildPage() {
  const [assets, templates] = await Promise.all([loadAssetsResponse(), loadTemplates()]);
  return (
    <StrategiesShell tab="build">
      <Suspense fallback={<Skeleton className="h-[480px]" />}>
        <BuildView initialAssets={assets ?? undefined} initialTemplates={templates} embedded />
      </Suspense>
    </StrategiesShell>
  );
}

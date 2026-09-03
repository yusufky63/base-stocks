import type { Metadata } from "next";
import { Suspense } from "react";
import { BuildView } from "@/components/build/BuildView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";
import { loadAssetsResponse, loadTemplates } from "@/lib/server-data";
import { Skeleton } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Build" };

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

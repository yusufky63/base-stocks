import type { Metadata } from "next";
import { Suspense } from "react";
import { AutomateView } from "@/components/automate/AutomateView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";
import { loadTemplates } from "@/lib/server-data";
import { Skeleton } from "@/components/ui/primitives";

/** Rendered at most every 60 s and served from the cache between; the client refreshes prices itself. */
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Automate",
  description: "Buy a stock or a basket on a schedule — automatically within limits the chain enforces, or with a confirmation per run.",
};

export default async function AutomatePage() {
  const templates = await loadTemplates();
  return (
    <StrategiesShell tab="automate">
      <Suspense fallback={<Skeleton className="h-[480px]" />}>
        <AutomateView initialTemplates={templates} embedded />
      </Suspense>
    </StrategiesShell>
  );
}

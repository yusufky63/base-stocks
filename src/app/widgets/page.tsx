import type { Metadata } from "next";
import { PageTitle } from "@/components/ui/primitives";
import { WidgetBuilder } from "@/components/widgets/WidgetBuilder";
import { findCuratedAsset } from "@/lib/b20/registry";
import { pageMeta } from "@/lib/page-meta";

export const metadata: Metadata = pageMeta({
  title: "Widgets",
  description: "Put a stock's buy / sell panel or its live price and chart on your own site with one iframe. Visitors trade from their own wallet.",
  path: "/widgets",
});

type Props = { searchParams: Promise<{ asset?: string }> };

export default async function WidgetsPage({ searchParams }: Props) {
  const { asset } = await searchParams;
  const initial = asset ? findCuratedAsset(asset)?.address : undefined;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="Widgets"
        title="BStocks on your own site"
        lead="One iframe each: a stock's buy / sell panel, or its live price and chart. Visitors sign in their own wallet and the trade goes straight to the route the quote names; your site never holds funds, keys or approvals."
      />
      <WidgetBuilder initialAsset={initial} />
    </div>
  );
}

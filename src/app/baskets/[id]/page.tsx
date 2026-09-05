import type { Metadata } from "next";
import { getRepos } from "@/db/repositories";
import { BasketDetailView } from "@/components/community/BasketDetailView";
import { StrategiesShell } from "@/components/strategies/StrategiesShell";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const b = await getRepos().baskets.get(id).catch(() => null);
  return {
    title: b ? `${b.name} · Basket` : "Basket",
    description: b?.description || "A community basket of tokenized stocks on Base.",
    openGraph: b ? { title: `${b.name} · BStocks`, description: b.description || "A community basket of tokenized stocks on Base." } : undefined,
  };
}

/** A community basket is a Community page; the section tabs stay so the way back is one tap. */
export default async function BasketPage({ params }: Props) {
  const { id } = await params;
  return (
    <StrategiesShell tab="community" compact>
      <BasketDetailView id={id} />
    </StrategiesShell>
  );
}

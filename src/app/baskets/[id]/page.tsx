import type { Metadata } from "next";
import { getRepos } from "@/db/repositories";
import { BasketDetailView } from "@/components/community/BasketDetailView";

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

export default async function BasketPage({ params }: Props) {
  const { id } = await params;
  return <BasketDetailView id={id} />;
}

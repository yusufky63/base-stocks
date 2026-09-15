import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getGiftReceipt } from "@/services/gift-service";
import { giftAmountLabel, giftPartyName } from "@/lib/gift/format";
import { GiftReceiptView } from "@/components/gift/GiftReceiptView";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const r = await getGiftReceipt(id).catch(() => null);
  if (!r) return { title: "Gift" };
  const title = `${giftAmountLabel(r)} gift`;
  const description = `${giftPartyName(r.sender)} sent ${giftAmountLabel(r)}, a Coinbase Tokenized Stock on Base, to ${giftPartyName(r.recipient)} with BStocks.`;
  return { title, description, openGraph: { title: `${title} · BStocks`, description } };
}

/** Public gift receipt: what was sent, by whom, to whom, with the onchain proof. Shared from X or the Base app. */
export default async function GiftPage({ params }: Props) {
  const { id } = await params;
  const receipt = await getGiftReceipt(id).catch(() => null);
  if (!receipt) notFound();
  return <GiftReceiptView receipt={receipt} />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getGiftReceipt, giftAmountLabel, giftPartyLabel } from "@/services/gift-service";
import { ClaimView } from "@/components/gift/ClaimView";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const r = await getGiftReceipt(id).catch(() => null);
  if (!r || r.gift.kind !== "claim-link") return { title: "Gift", robots: { index: false } };
  const title = `A gift for you · ${giftAmountLabel(r)}`;
  const description = `${giftPartyLabel(r.sender)} sent ${giftAmountLabel(r)}, a Coinbase Tokenized Stock on Base. No wallet needed — open the link to claim it with a passkey.`;
  return { title, description, robots: { index: false }, openGraph: { title: `${title} · BStocks`, description } };
}

/** Claim page for link gifts. The claim key travels only in the URL fragment, which never reaches this server. */
export default async function ClaimPage({ params }: Props) {
  const { id } = await params;
  const receipt = await getGiftReceipt(id).catch(() => null);
  if (!receipt || receipt.gift.kind !== "claim-link") notFound();
  return <ClaimView initialReceipt={receipt} />;
}

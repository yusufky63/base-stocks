import { OG } from "@/lib/og";
import { shareCard } from "@/lib/share-card";

export const alt = "BStocks — Tokenized Stocks on Base";
export const size = OG.size;
export const contentType = "image/png";

/** Site-wide share card at the Open Graph ratio; the 3:2 embed version lives at /miniapp-image. */
export default function Image() {
  return shareCard(size);
}

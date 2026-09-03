import type { Metadata } from "next";
import { GiftsView } from "@/components/gift/GiftsView";

export const metadata: Metadata = {
  title: "Gift",
  description: "Send tokenized stock to a Basename or address, or create claim links that need no wallet — self-custodial gifts on Base.",
};

export default function GiftsPage() {
  return <GiftsView />;
}

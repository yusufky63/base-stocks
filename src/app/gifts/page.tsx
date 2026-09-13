import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { GiftsView } from "@/components/gift/GiftsView";

export const metadata: Metadata = pageMeta({
  title: "Gift",
  description: "Send tokenized stock to a Basename or address, or create claim links that need no wallet — self-custodial gifts on Base.",
  path: "/gifts",
});

export default function GiftsPage() {
  return <GiftsView />;
}

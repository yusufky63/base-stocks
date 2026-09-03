import type { Metadata } from "next";
import { EarnOverview } from "@/components/earn/EarnOverview";

export const metadata: Metadata = { title: "Earn" };

export default function EarnPage() {
  return <EarnOverview />;
}

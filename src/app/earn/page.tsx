import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { EarnOverview } from "@/components/earn/EarnOverview";

export const metadata: Metadata = pageMeta({ title: "Earn", path: "/earn" });

export default function EarnPage() {
  return <EarnOverview />;
}

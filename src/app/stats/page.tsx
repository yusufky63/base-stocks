import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { StatsView } from "@/components/stats/StatsView";

export const metadata: Metadata = pageMeta({
  title: "Stats",
  description: "What has been done through BStocks: trades, volume, wallets, gifts, pools, Earn deposits and plan runs, every figure verified against the transaction receipt on Base.",
  path: "/stats",
});

export default function StatsPage() {
  return <StatsView />;
}

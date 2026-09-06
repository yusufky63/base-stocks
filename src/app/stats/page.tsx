import type { Metadata } from "next";
import { StatsView } from "@/components/stats/StatsView";

export const metadata: Metadata = {
  title: "Stats · BaseStocks",
  description: "What has been done through BaseStocks: trades, volume, wallets, gifts, pools, Earn deposits and plan runs, every figure verified against the transaction receipt on Base.",
};

export default function StatsPage() {
  return <StatsView />;
}

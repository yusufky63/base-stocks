import type { Metadata } from "next";
import { StatusView } from "@/components/status/StatusView";

export const metadata: Metadata = { title: "Status · BStocks", description: "Live status of the chain, price feeds, trading routes, yield venues and news feeds BStocks depends on." };

export default function StatusPage() {
  return <StatusView />;
}

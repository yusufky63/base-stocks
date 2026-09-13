import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { StatusView } from "@/components/status/StatusView";

export const metadata: Metadata = pageMeta({ title: "Status", description: "Live status of the chain, price feeds, trading routes, yield venues and news feeds BaseStocks depends on.", path: "/status" });

export default function StatusPage() {
  return <StatusView />;
}

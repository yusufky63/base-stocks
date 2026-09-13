import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { PoolsDirectory } from "@/components/pool/PoolsDirectory";

export const metadata: Metadata = pageMeta({
  title: "Gift pools",
  description: "Open gift pools on BaseStocks: one deposit, many equal shares of tokenized stock. Take your share with any wallet on Base.",
  path: "/pools",
});

export default function PoolsPage() {
  return <PoolsDirectory />;
}

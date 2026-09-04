import type { Metadata } from "next";
import { PoolsDirectory } from "@/components/pool/PoolsDirectory";

export const metadata: Metadata = {
  title: "Gift pools",
  description: "Open gift pools on BStocks: one deposit, many equal shares of tokenized stock. Take your share with any wallet on Base.",
};

export default function PoolsPage() {
  return <PoolsDirectory />;
}

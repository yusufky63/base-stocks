import type { Metadata } from "next";
import { NewsView } from "@/components/news/NewsView";

export const metadata: Metadata = { title: "News", description: "Short headlines for Coinbase Tokenized Stocks and the wider market, from several publishers." };

export default function NewsPage() {
  return <NewsView />;
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { NewsView } from "@/components/news/NewsView";
import { Skeleton } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "News", description: "Headlines for Coinbase Tokenized Stocks on Base — the listings and venues first — plus the wider market, from several publishers, with a shared AI brief every six hours." };

/** `?scope=ecosystem` opens the Base & Coinbase feed directly; reading it needs a boundary. */
export default function NewsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[480px]" />}>
      <NewsView />
    </Suspense>
  );
}

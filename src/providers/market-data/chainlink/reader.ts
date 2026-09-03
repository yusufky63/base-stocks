import type { Address } from "viem";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { aggregatorV3Abi } from "@/lib/chainlink/abi";
import { metrics } from "@/lib/http";

export interface FeedReading {
  feed: Address;
  answer: bigint;
  updatedAt: bigint;
  decimals: number;
}

/**
 * Read many Chainlink feeds in one multicall. Feeds that fail return null.
 * Callers MUST apply staleness bounds before relying on `answer`.
 */
export async function readFeeds(feeds: Address[]): Promise<Map<string, FeedReading | null>> {
  const out = new Map<string, FeedReading | null>();
  if (feeds.length === 0) return out;
  const client = getServerPublicClient();
  const contracts = feeds.flatMap((feed) => [
    { address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" } as const,
    { address: feed, abi: aggregatorV3Abi, functionName: "decimals" } as const,
  ]);
  try {
    const results = await client.multicall({ contracts, allowFailure: true });
    feeds.forEach((feed, i) => {
      const round = results[i * 2];
      const dec = results[i * 2 + 1];
      if (round?.status === "success" && dec?.status === "success") {
        const [, answer, , updatedAt] = round.result as readonly [bigint, bigint, bigint, bigint, bigint];
        out.set(feed.toLowerCase(), { feed, answer, updatedAt, decimals: Number(dec.result) });
      } else {
        out.set(feed.toLowerCase(), null);
      }
    });
    metrics.count("chainlink.readFeeds", true);
  } catch (err) {
    metrics.count("chainlink.readFeeds", false, err instanceof Error ? err.message : String(err));
    feeds.forEach((f) => out.set(f.toLowerCase(), null));
  }
  return out;
}

export function isStale(updatedAt: bigint, thresholdSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return nowSeconds - Number(updatedAt) > thresholdSeconds;
}

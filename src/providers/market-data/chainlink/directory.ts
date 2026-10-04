import { z } from "zod";
import { getAddress, type Address } from "viem";
import { cached } from "@/lib/cache";
import { fetchJson, metrics } from "@/lib/http";

/**
 * Chainlink's public feed directory for Base (the JSON behind docs.chain.link's address tables).
 * Coinbase stock feeds are listed as `name: "Coinbase <TICKER>"` with
 * `assetName: "<Company> (Coinbase Tokenized Equity)"`. Used to match a newly discovered
 * stock token to its reference feed without a code change. Verified 2026-09-02 (183 entries).
 */
const DIRECTORY_URL = "https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json";

const entrySchema = z.object({
  name: z.string().optional(),
  proxyAddress: z.string().nullable().optional(),
  assetName: z.string().optional(),
  feedCategory: z.string().optional(),
  decimals: z.number().optional(),
});

export interface CoinbaseFeedEntry {
  underlying: string;
  proxyAddress: Address;
  assetName: string;
  decimals: number | null;
}

export async function getCoinbaseStockFeeds(): Promise<Map<string, CoinbaseFeedEntry>> {
  return cached("chainlink:directory:coinbase:v2", { ttlMs: 15 * 60_000, shared: true }, async () => {
    const { status, data } = await fetchJson<unknown>(DIRECTORY_URL, { timeoutMs: 10_000, provider: "chainlink.directory" });
    if (status >= 400) throw new Error(`chainlink directory http ${status}`);
    const arr = Array.isArray(data) ? data : ((data as { feeds?: unknown[] })?.feeds ?? []);
    const out = new Map<string, CoinbaseFeedEntry>();
    for (const raw of arr) {
      const p = entrySchema.safeParse(raw);
      if (!p.success) continue;
      const m = /^Coinbase\s+([A-Z0-9.]{1,8})$/i.exec(p.data.name ?? "");
      if (!m || !p.data.proxyAddress || !/^0x[0-9a-f]{40}$/i.test(p.data.proxyAddress) || !/Coinbase Tokenized Equity/i.test(p.data.assetName ?? "")) continue;
      out.set(m[1]!.toUpperCase(), { underlying: m[1]!.toUpperCase(), proxyAddress: getAddress(p.data.proxyAddress.toLowerCase()), assetName: p.data.assetName ?? "", decimals: p.data.decimals ?? null });
    }
    if (out.size === 0) metrics.count("chainlink.directory", false, "no Coinbase feeds parsed");
    return out;
  });
}

/** The Chainlink feed for a Coinbase-tokenized underlying, or null when Chainlink does not list one. */
export async function findCoinbaseFeed(underlying: string): Promise<CoinbaseFeedEntry | null> {
  try {
    return (await getCoinbaseStockFeeds()).get(underlying.toUpperCase()) ?? null;
  } catch (err) {
    metrics.count("chainlink.directory", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

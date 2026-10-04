import { z } from "zod";
import { getAddress, type Address } from "viem";
import { cached } from "@/lib/cache";
import { fetchJson } from "@/lib/http";

const LIST_URL = "https://api.coinbase.com/v1/tokenized-stocks";
const tokenSchema = z.object({
  contract_address: z.string().regex(/^0xb2[0-9a-f]{38}$/i),
  symbol: z.string().regex(/^[A-Z0-9.]{1,7}c$/),
  name: z.string().min(1),
  // Read loosely: a bad price must cost the token its reading, never its listing.
  nav_price: z.unknown().optional(),
  nav_price_updated_at: z.unknown().optional(),
});
const listSchema = z.object({ tokens: z.array(z.unknown()) });

export interface CoinbaseStockListing {
  address: Address;
  symbol: string;
  name: string;
}

/**
 * Coinbase's own copy of the token's Chainlink reading, as the API publishes it. The same number a
 * feed read returns, not a second opinion: it exists only where a feed exists, and it is used when
 * the feed itself could not be read.
 */
export interface CoinbaseNavReading {
  priceUsd: number;
  /** Unix seconds: the feed round's own `updatedAt`, not when the API was asked. */
  updatedAt: number;
}

interface CoinbaseStockRecord extends CoinbaseStockListing {
  nav: CoinbaseNavReading | null;
}

function parseNav(price: unknown, updatedAt: unknown): CoinbaseNavReading | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || typeof updatedAt !== "string") return null;
  const at = Date.parse(updatedAt);
  // A round stamped in the future is not a reading anyone can age.
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 60_000) return null;
  return { priceUsd: price, updatedAt: Math.floor(at / 1000) };
}

/** One fetch serves the listing and the readings; short enough that a reading is never far behind the feed. */
async function getCoinbaseStockRecords(): Promise<CoinbaseStockRecord[]> {
  return cached("coinbase:stocks:v2", { ttlMs: 2 * 60_000, shared: true }, async () => {
    const { status, data } = await fetchJson<unknown>(LIST_URL, { timeoutMs: 10_000, provider: "coinbase.stocks" });
    if (status >= 400) throw new Error(`Coinbase stock list HTTP ${status}`);
    const { tokens } = listSchema.parse(data);
    const records = new Map<string, CoinbaseStockRecord>();
    for (const raw of tokens) {
      const p = tokenSchema.safeParse(raw);
      if (!p.success) continue;
      // Some official API records have invalid mixed-case checksums. Preserve the bytes,
      // then compute EIP-55, rather than letting one address poison a whole multicall.
      const address = getAddress(p.data.contract_address.toLowerCase());
      if (address.slice(22, 24) !== "00") continue; // B20 ASSET variant
      records.set(address.toLowerCase(), { address, name: p.data.name, symbol: p.data.symbol, nav: parseNav(p.data.nav_price, p.data.nav_price_updated_at) });
    }
    return [...records.values()];
  });
}

/** Issuer identity only: Chainlink readiness and token state are verified separately onchain. */
export async function getCoinbaseStockListings(): Promise<CoinbaseStockListing[]> {
  return (await getCoinbaseStockRecords()).map(({ address, name, symbol }) => ({ address, name, symbol }));
}

/** NAV readings by lowercase token address, for the tokens that have one. */
export async function getCoinbaseNavReadings(): Promise<Map<string, CoinbaseNavReading>> {
  const out = new Map<string, CoinbaseNavReading>();
  for (const r of await getCoinbaseStockRecords()) if (r.nav) out.set(r.address.toLowerCase(), r.nav);
  return out;
}

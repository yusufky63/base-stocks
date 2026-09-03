import type { Address } from "viem";
import { z } from "zod";
import type { TokenMarketData } from "@/domain/market";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { AppError } from "@/lib/errors";

/**
 * DexScreener public token endpoint (no API key, ~300 req/min).
 * https://api.dexscreener.com/tokens/v1/{chain}/{addresses}  (up to 30 addresses per call)
 * Used for shared price snapshots: price, 24h change, volume, liquidity, primary pair.
 */
const BASE_URL = "https://api.dexscreener.com";
const CHAIN = "base";
const MAX_PER_CALL = 30;
const breaker = new CircuitBreaker("dexscreener", 3, 30_000);

const numLike = z.union([z.number(), z.string()]).nullable().optional();

const pairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string().optional(),
    pairAddress: z.string(),
    baseToken: z.object({ address: z.string(), name: z.string().optional(), symbol: z.string().optional() }),
    quoteToken: z.object({ address: z.string(), name: z.string().optional(), symbol: z.string().optional() }).optional(),
    priceUsd: numLike,
    priceChange: z.object({ h24: numLike }).partial().optional(),
    volume: z.object({ h24: numLike }).partial().optional(),
    liquidity: z.object({ usd: numLike }).partial().optional(),
    marketCap: numLike,
    fdv: numLike,
    info: z.object({ imageUrl: z.string().optional() }).partial().optional(),
  })
  .passthrough();

const responseSchema = z.array(pairSchema);

export type DexScreenerPair = z.infer<typeof pairSchema>;

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchPairs(addresses: Address[]): Promise<DexScreenerPair[]> {
  const out: DexScreenerPair[] = [];
  for (let i = 0; i < addresses.length; i += MAX_PER_CALL) {
    const chunk = addresses.slice(i, i + MAX_PER_CALL);
    const raw = await breaker.run(async () => {
      const { status, data } = await fetchJson<unknown>(`${BASE_URL}/tokens/v1/${CHAIN}/${chunk.join(",")}`, { timeoutMs: 8_000, provider: "dexscreener" });
      if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "dexscreener: rate limited", 503);
      if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `dexscreener: http ${status}`, 502);
      return data;
    });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "dexscreener: unexpected schema", 502);
    out.push(...parsed.data);
  }
  return out;
}

/** Best pair per token: the deepest pool where the token is the base asset. */
export function pickPrimaryPairs(pairs: DexScreenerPair[], addresses: Address[]): Map<string, DexScreenerPair> {
  const best = new Map<string, DexScreenerPair>();
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    const base = p.baseToken.address.toLowerCase();
    if (!wanted.has(base)) continue;
    const liq = toNum(p.liquidity?.usd) ?? 0;
    const cur = best.get(base);
    if (!cur || liq > (toNum(cur.liquidity?.usd) ?? 0)) best.set(base, p);
  }
  return best;
}

export async function getDexScreenerMarkets(addresses: Address[]): Promise<Map<string, TokenMarketData>> {
  const out = new Map<string, TokenMarketData>();
  if (addresses.length === 0) return out;
  try {
    const pairs = await fetchPairs(addresses);
    const best = pickPrimaryPairs(pairs, addresses);
    const now = Date.now();
    for (const addr of addresses) {
      const p = best.get(addr.toLowerCase());
      if (!p) continue;
      const price = toNum(p.priceUsd);
      out.set(addr.toLowerCase(), {
        address: addr,
        priceUsd: price !== null && price > 0 ? price : null,
        change24hPct: toNum(p.priceChange?.h24),
        volume24hUsd: toNum(p.volume?.h24),
        liquidityUsd: toNum(p.liquidity?.usd),
        marketCapUsd: toNum(p.marketCap) ?? toNum(p.fdv),
        source: "dexscreener",
        updatedAt: now,
        primaryPool: p.pairAddress as Address,
      });
    }
    metrics.count("dexscreener.markets", true);
  } catch (err) {
    metrics.count("dexscreener.markets", false, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return out;
}

export async function getDexScreenerLogo(address: Address): Promise<string | null> {
  try {
    const pairs = await fetchPairs([address]);
    const best = pickPrimaryPairs(pairs, [address]).get(address.toLowerCase());
    return best?.info?.imageUrl ?? null;
  } catch {
    return null;
  }
}

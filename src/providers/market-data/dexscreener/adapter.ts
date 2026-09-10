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

/**
 * Best pair per token: the deepest pool where the token is the base asset **and** the quote is
 * something dollars can be reached through.
 *
 * The quote rule is the whole point, and it was already applied to depth while price went without
 * it. A pool prices a token against whatever sits on the other side, so a pair against a long-tail
 * token reports that token's own valuation, not the stock's. TSLAc spent a day displayed at
 * $17,936 against a Chainlink reference of $366 because the upstream's one returned pair was quoted
 * in a token whose own dollar price was nonsense: 48.97x out, on a page that also said "Live".
 *
 * Depth cannot rescue this either. That pair held real money; being deep and being a price are
 * different properties, and only the second one is being chosen here.
 */
export function pickPrimaryPairs(pairs: DexScreenerPair[], addresses: Address[]): Map<string, DexScreenerPair> {
  const best = new Map<string, DexScreenerPair>();
  const wanted = new Set(addresses.map((a) => a.toLowerCase()));
  for (const p of pairs) {
    if (p.chainId !== CHAIN) continue;
    const base = p.baseToken.address.toLowerCase();
    if (!wanted.has(base)) continue;
    const quote = p.quoteToken?.address?.toLowerCase();
    if (!quote || !MAJOR_QUOTES.has(quote)) continue;
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
    // Liquidity and volume describe the token's whole tradable depth, not its deepest single pool.
    // Price, the 24h move and market cap stay with the primary pair: those belong to one market,
    // and averaging them across pools of wildly different size would invent a number nobody quoted.
    try {
      const depths = await getDexScreenerDepths([...out.values()].map((v) => v.address), best);
      for (const [k, v] of out) {
        const d = depths.get(k);
        if (d) out.set(k, { ...v, liquidityUsd: d.liquidityUsd, volume24hUsd: d.volume24hUsd });
      }
    } catch (err) {
      // A failed depth pass leaves the single-pool figures, which understate but never mislead.
      metrics.count("dexscreener.depth", false, err instanceof Error ? err.message : String(err));
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

/**
 * Quote assets an aggregator can route to dollars through.
 *
 * Matched by address, never by symbol: a pool can name its token "USDC" and nothing stops it.
 */
const MAJOR_QUOTES = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0x4200000000000000000000000000000000000006", // WETH
  "0x0000000000000000000000000000000000000000", // native ETH
]);

export interface TokenDepth {
  liquidityUsd: number;
  volume24hUsd: number;
  /** How many pools the total is made of, for the "we show N pools" line. */
  pools: number;
}

/**
 * Total depth behind a token, rather than its deepest single pool.
 *
 * Two kinds of pair get left out, and both matter:
 *
 * The token has to be the *base* asset. A memecoin paired against NVDAc — and there are seven of
 * them, holding real money — is depth for that memecoin, not for NVDA: you cannot sell NVDA into
 * it and end up with dollars. A competitor's table sums these, which is why its liquidity figure
 * runs half a million dollars ahead of anything you could trade against.
 *
 * The quote has to be something an aggregator can reach dollars through. That drops pairs against
 * a wrapped version of the token itself, which is circular, and against long-tail tokens whose own
 * depth is the real constraint.
 */
export function aggregateDepth(pairs: DexScreenerPair[], address: Address, primary?: DexScreenerPair | null): TokenDepth | null {
  const base = address.toLowerCase();
  const qualifies = (p: DexScreenerPair): boolean => {
    if (p.chainId !== CHAIN) return false;
    if (p.baseToken.address.toLowerCase() !== base) return false;
    const quote = p.quoteToken?.address?.toLowerCase();
    if (!quote || !MAJOR_QUOTES.has(quote)) return false;
    return (toNum(p.liquidity?.usd) ?? 0) > 0;
  };

  let liquidityUsd = 0;
  let volume24hUsd = 0;
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!qualifies(p)) continue;
    seen.add(p.pairAddress.toLowerCase());
    liquidityUsd += toNum(p.liquidity?.usd) ?? 0;
    volume24hUsd += toNum(p.volume?.h24) ?? 0;
  }

  // The full-pair endpoint caps its answer at thirty pools and the thirty it picks move around:
  // Strategy's deepest pool dropped out of one response and the total came back at $21.8k against
  // the $121.7k actually there, which is the difference between "thin" and "live" on the stock
  // page. So the pair the batch endpoint already gave us is folded in whenever the long list
  // forgot it. The total can then be short, never shorter than what we already knew.
  if (primary && qualifies(primary) && !seen.has(primary.pairAddress.toLowerCase())) {
    seen.add(primary.pairAddress.toLowerCase());
    liquidityUsd += toNum(primary.liquidity?.usd) ?? 0;
    volume24hUsd += toNum(primary.volume?.h24) ?? 0;
  }

  return seen.size === 0 ? null : { liquidityUsd, volume24hUsd, pools: seen.size };
}

/**
 * Every pair DexScreener knows for one token.
 *
 * The batched `tokens/v1` endpoint returns only the top pair per token and caps a multi-token call
 * at thirty pairs total, so asking for thirteen stocks there yields two pools each. Depth needs the
 * whole list, and the whole list is one token at a time.
 */
async function fetchAllPairs(address: Address): Promise<DexScreenerPair[]> {
  const raw = await breaker.run(async () => {
    const { status, data } = await fetchJson<unknown>(`${BASE_URL}/latest/dex/tokens/${address}`, { timeoutMs: 8_000, provider: "dexscreener" });
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "dexscreener: rate limited", 503);
    if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `dexscreener: http ${status}`, 502);
    return data;
  });
  const parsed = z.object({ pairs: responseSchema.nullable().optional() }).safeParse(raw);
  return parsed.success ? (parsed.data.pairs ?? []) : [];
}

/**
 * Depth per token, each fetched on its own and each allowed to fail alone.
 *
 * A token whose call fails simply keeps the single-pool figures it already had, which understate
 * but never mislead.
 */
export async function getDexScreenerDepths(addresses: Address[], primaries?: Map<string, DexScreenerPair>): Promise<Map<string, TokenDepth>> {
  const out = new Map<string, TokenDepth>();
  const settled = await Promise.allSettled(addresses.map(async (a) => [a, await fetchAllPairs(a)] as const));
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    const [address, pairs] = r.value;
    const depth = aggregateDepth(pairs, address, primaries?.get(address.toLowerCase()));
    if (depth) out.set(address.toLowerCase(), depth);
  }
  return out;
}

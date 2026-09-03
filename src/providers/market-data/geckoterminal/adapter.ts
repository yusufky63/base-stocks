import type { Address } from "viem";
import { z } from "zod";
import type { Candle, Timeframe, TokenMetadata } from "@/domain/market";
import { cached, TTL } from "@/lib/cache";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { gate } from "@/lib/rate-gate";
import { AppError } from "@/lib/errors";
import { ohlcvResponseSchema, tokenInfoResponseSchema, toNum, type CoinGeckoPool } from "../coingecko/schemas";
import { OHLCV_SPECS } from "../timeframes";

/**
 * GeckoTerminal public API (no key, ~30 req/min). Same response shapes as CoinGecko's
 * onchain endpoints, so the schemas are shared. Used for OHLCV + metadata; every call is
 * cached server-side so one upstream request serves all visitors.
 */
const BASE_URL = "https://api.geckoterminal.com/api/v2";
const NETWORK = "base";
const breaker = new CircuitBreaker("geckoterminal", 3, 45_000);

const multiSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        address: z.string(),
        price_usd: z.union([z.number(), z.string()]).nullable().optional(),
        volume_usd: z.object({ h24: z.union([z.number(), z.string()]).nullable().optional() }).partial().optional(),
        total_reserve_in_usd: z.union([z.number(), z.string()]).nullable().optional(),
        market_cap_usd: z.union([z.number(), z.string()]).nullable().optional(),
        image_url: z.string().nullable().optional(),
      }),
      relationships: z.object({ top_pools: z.object({ data: z.array(z.object({ id: z.string() })) }).optional() }).optional(),
    }),
  ),
});

async function get<T>(path: string, timeoutMs = 10_000): Promise<T> {
  return breaker.run(async () => {
    await gate("geckoterminal", 2_200); // keyless tier: ~30 requests per minute, shared with pool discovery
    const { status, data } = await fetchJson<T>(`${BASE_URL}${path}`, { headers: { accept: "application/json;version=20230302" }, timeoutMs, provider: "geckoterminal" });
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "geckoterminal: rate limited", 503);
    if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `geckoterminal: http ${status}`, 502);
    return data;
  });
}

function pickPrimaryPool(pools: CoinGeckoPool[]): CoinGeckoPool | null {
  let best: CoinGeckoPool | null = null;
  let bestReserve = -1;
  for (const p of pools) {
    const r = toNum(p.attributes.reserve_in_usd) ?? 0;
    if (r > bestReserve) {
      best = p;
      bestReserve = r;
    }
  }
  return best;
}

async function tokenInfo(address: Address) {
  return cached(`gt:info:${address.toLowerCase()}`, TTL.logo, async () => {
    const raw = await get<unknown>(`/networks/${NETWORK}/tokens/${address.toLowerCase()}?include=top_pools`);
    const parsed = tokenInfoResponseSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "geckoterminal: unexpected token schema", 502);
    return parsed.data;
  });
}

export async function getGeckoTerminalMetadata(address: Address): Promise<TokenMetadata | null> {
  try {
    const info = await tokenInfo(address);
    const a = info.data.attributes;
    return { address, name: a.name, symbol: a.symbol, decimals: a.decimals, logoURI: a.image_url ?? undefined };
  } catch (err) {
    metrics.count("geckoterminal.metadata", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Fallback price snapshot when DexScreener is unavailable (no 24h change available here). */
export async function getGeckoTerminalPrices(addresses: Address[]): Promise<Map<string, { priceUsd: number | null; volume24hUsd: number | null; liquidityUsd: number | null; marketCapUsd: number | null; primaryPool?: Address }>> {
  const out = new Map<string, { priceUsd: number | null; volume24hUsd: number | null; liquidityUsd: number | null; marketCapUsd: number | null; primaryPool?: Address }>();
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const raw = await get<unknown>(`/networks/${NETWORK}/tokens/multi/${chunk.map((a) => a.toLowerCase()).join(",")}`);
    const parsed = multiSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "geckoterminal: unexpected multi schema", 502);
    for (const t of parsed.data.data) {
      const poolId = t.relationships?.top_pools?.data[0]?.id;
      // Tokens without DEX liquidity report a zero price; treat that as "no market price".
      const price = toNum(t.attributes.price_usd);
      out.set(t.attributes.address.toLowerCase(), {
        priceUsd: price !== null && price > 0 ? price : null,
        volume24hUsd: toNum(t.attributes.volume_usd?.h24),
        liquidityUsd: toNum(t.attributes.total_reserve_in_usd),
        marketCapUsd: toNum(t.attributes.market_cap_usd),
        primaryPool: poolId ? (poolId.replace(/^base_/, "") as Address) : undefined,
      });
    }
  }
  return out;
}

export async function getGeckoTerminalPrimaryPool(address: Address): Promise<{ pool: Address; tokenIsBase: boolean } | null> {
  try {
    const info = await tokenInfo(address);
    const best = pickPrimaryPool(info.included ?? []);
    if (!best) return null;
    const baseId = best.relationships?.base_token?.data.id ?? "";
    return { pool: best.attributes.address as Address, tokenIsBase: baseId.toLowerCase().endsWith(address.toLowerCase()) };
  } catch {
    return null;
  }
}

/**
 * OHLCV for a pool. `tokenIsBase` decides which side of the pair is charted.
 * Cached per (pool, timeframe); the whole app shares one upstream request.
 */
export async function getGeckoTerminalOhlcv(pool: Address, tokenIsBase: boolean, timeframe: Timeframe): Promise<Candle[]> {
  const spec = OHLCV_SPECS[timeframe];
  return cached(`gt:ohlcv:${pool.toLowerCase()}:${tokenIsBase ? "base" : "quote"}:${timeframe}`, TTL.ohlcv, async () => {
    const raw = await get<unknown>(`/networks/${NETWORK}/pools/${pool.toLowerCase()}/ohlcv/${spec.timeframe}?aggregate=${spec.aggregate}&limit=${spec.limit}&currency=usd&token=${tokenIsBase ? "base" : "quote"}`, 12_000);
    const parsed = ohlcvResponseSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "geckoterminal: unexpected ohlcv schema", 502);
    const candles: Candle[] = [];
    for (const [t, o, h, l, c, v] of parsed.data.data.attributes.ohlcv_list) {
      const open = toNum(o), high = toNum(h), low = toNum(l), close = toNum(c);
      if (open === null || high === null || low === null || close === null) continue;
      candles.push({ time: t, open, high, low, close, volume: toNum(v) ?? 0 });
    }
    candles.sort((a, b) => a.time - b.time);
    metrics.count("geckoterminal.ohlcv", true);
    return candles;
  });
}

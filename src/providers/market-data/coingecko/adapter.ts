import type { Address } from "viem";
import { serverEnv } from "@/config/env";
import type { Candle, MarketDataProvider, Timeframe, TokenMarketData, TokenMetadata } from "@/domain/market";
import { cached, TTL } from "@/lib/cache";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { ohlcvResponseSchema, tokenInfoResponseSchema, tokenPriceResponseSchema, toNum, type CoinGeckoPool } from "./schemas";
import { OHLCV_SPECS as TIMEFRAME_SPECS } from "../timeframes";

const NETWORK = "base";
const breaker = new CircuitBreaker("coingecko", 3, 30_000);

function config() {
  const env = serverEnv();
  const pro = env.COINGECKO_API_TIER === "pro" && !!env.COINGECKO_API_KEY;
  const baseUrl = pro ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  const headers: Record<string, string> = {};
  if (env.COINGECKO_API_KEY) headers[pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = env.COINGECKO_API_KEY;
  return { baseUrl, headers };
}

async function get<T>(path: string, timeoutMs = 8_000): Promise<T> {
  const { baseUrl, headers } = config();
  return breaker.run(async () => {
    const { status, data } = await fetchJson<T>(`${baseUrl}${path}`, { headers, timeoutMs, provider: "coingecko" });
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "coingecko: rate limited", 503);
    if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `coingecko: http ${status}`, 502);
    return data;
  });
}

/** Choose the deepest pool where the token participates. */
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

export class CoinGeckoMarketDataProvider implements MarketDataProvider {
  readonly id = "coingecko";

  async getTokenMarkets(addresses: Address[]): Promise<Map<string, TokenMarketData>> {
    const out = new Map<string, TokenMarketData>();
    if (addresses.length === 0) return out;
    const key = `cg:prices:${addresses.map((a) => a.toLowerCase()).sort().join(",")}`;
    const rows = await cached(key, TTL.market, async () => {
      const list = addresses.map((a) => a.toLowerCase()).join(",");
      const raw = await get<unknown>(
        `/onchain/simple/networks/${NETWORK}/token_price/${list}?include_24hr_vol=true&include_24hr_price_change=true&include_market_cap=true&include_total_reserve_in_usd=true`,
      );
      const parsed = tokenPriceResponseSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "coingecko: unexpected price schema", 502);
      const attrs = parsed.data.data.attributes;
      const now = Date.now();
      const result: Array<[string, TokenMarketData]> = [];
      for (const addr of addresses) {
        const k = Object.keys(attrs.token_prices).find((x) => x.toLowerCase() === addr.toLowerCase());
        if (!k) continue;
        result.push([
          addr.toLowerCase(),
          {
            address: addr,
            priceUsd: toNum(attrs.token_prices[k]),
            change24hPct: toNum(attrs.h24_price_change_percentage?.[k]),
            volume24hUsd: toNum(attrs.h24_volume_usd?.[k]),
            liquidityUsd: toNum(attrs.total_reserve_in_usd?.[k]),
            marketCapUsd: toNum(attrs.market_cap_usd?.[k]),
            source: this.id,
            updatedAt: now,
          },
        ]);
      }
      return result;
    });
    for (const [k, v] of rows) out.set(k, v);
    return out;
  }

  async getTokenMarket(address: Address): Promise<TokenMarketData | null> {
    const m = await this.getTokenMarkets([address]);
    return m.get(address.toLowerCase()) ?? null;
  }

  private async getTokenInfo(address: Address) {
    return cached(`cg:info:${address.toLowerCase()}`, TTL.logo, async () => {
      const raw = await get<unknown>(`/onchain/networks/${NETWORK}/tokens/${address.toLowerCase()}?include=top_pools`);
      const parsed = tokenInfoResponseSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "coingecko: unexpected token schema", 502);
      return parsed.data;
    });
  }

  async getTokenMetadata(address: Address): Promise<TokenMetadata | null> {
    try {
      const info = await this.getTokenInfo(address);
      const a = info.data.attributes;
      return { address, name: a.name, symbol: a.symbol, decimals: a.decimals, logoURI: a.image_url ?? undefined };
    } catch (err) {
      metrics.count("coingecko.metadata", false, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Primary pool + which side the token is on, for OHLCV and DEX discovery. */
  async getPrimaryPool(address: Address): Promise<{ pool: Address; dex: string | null; reserveUsd: number | null; tokenIsBase: boolean } | null> {
    try {
      const info = await this.getTokenInfo(address);
      const pools = info.included ?? [];
      const best = pickPrimaryPool(pools);
      if (!best) return null;
      const baseId = best.relationships?.base_token?.data.id ?? "";
      const tokenIsBase = baseId.toLowerCase().endsWith(address.toLowerCase());
      return {
        pool: best.attributes.address as Address,
        dex: best.relationships?.dex?.data.id ?? null,
        reserveUsd: toNum(best.attributes.reserve_in_usd),
        tokenIsBase,
      };
    } catch {
      return null;
    }
  }

  /** All pools for a token (used by the Aerodrome liquidity discovery adapter). */
  async getPools(address: Address): Promise<Array<{ pool: Address; dex: string | null; name: string | null; reserveUsd: number | null; volume24hUsd: number | null }>> {
    try {
      const info = await this.getTokenInfo(address);
      return (info.included ?? []).map((p) => ({
        pool: p.attributes.address as Address,
        dex: p.relationships?.dex?.data.id ?? null,
        name: p.attributes.name ?? null,
        reserveUsd: toNum(p.attributes.reserve_in_usd),
        volume24hUsd: toNum(p.attributes.volume_usd?.h24),
      }));
    } catch {
      return [];
    }
  }

  async getTokenOhlcv(address: Address, timeframe: Timeframe): Promise<Candle[]> {
    const spec = TIMEFRAME_SPECS[timeframe];
    const primary = await this.getPrimaryPool(address);
    if (!primary) return [];
    const key = `cg:ohlcv:${address.toLowerCase()}:${timeframe}`;
    return cached(key, TTL.ohlcv, async () => {
      const tokenParam = primary.tokenIsBase ? "base" : "quote";
      const raw = await get<unknown>(
        `/onchain/networks/${NETWORK}/pools/${primary.pool}/ohlcv/${spec.timeframe}?aggregate=${spec.aggregate}&limit=${spec.limit}&currency=usd&token=${tokenParam}`,
        12_000,
      );
      const parsed = ohlcvResponseSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "coingecko: unexpected ohlcv schema", 502);
      const candles: Candle[] = [];
      for (const [t, o, h, l, c, v] of parsed.data.data.attributes.ohlcv_list) {
        const open = toNum(o), high = toNum(h), low = toNum(l), close = toNum(c);
        if (open === null || high === null || low === null || close === null) continue;
        candles.push({ time: t, open, high, low, close, volume: toNum(v) ?? 0 });
      }
      candles.sort((a, b) => a.time - b.time);
      return candles;
    });
  }
}

export const coinGeckoProvider = new CoinGeckoMarketDataProvider();

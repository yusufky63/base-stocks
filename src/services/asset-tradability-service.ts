import { parseUnits, type Address } from "viem";
import { BASE_CHAIN_ID, DEFAULT_SLIPPAGE_BPS, MIN_TRADE_USD, USDC_ADDRESS, USDC_DECIMALS } from "@/config/chain";
import type { TokenMarketData } from "@/domain/market";
import type { IndicativeQuote, TradeIntent } from "@/domain/trade";
import { cached } from "@/lib/cache";
import { raceWithFallback } from "@/lib/fallback";
import { MAX_LEG_POOL_SHARE } from "@/lib/trading-status";
import { getTradeProviders } from "@/providers/trading";

/** Enough depth for the existing $1 minimum at the portfolio's 2% pool-share limit. */
export const MIN_LISTING_LIQUIDITY_USD = MIN_TRADE_USD / MAX_LEG_POOL_SHARE;
export const LISTING_MARKET_MAX_AGE_MS = 5 * 60_000;

export function marketListingBlockedReason(market: TokenMarketData | null | undefined, now = Date.now()): string | null {
  if (!market?.primaryPool) return "no DEX pool with a price";
  if (!Number.isFinite(market.priceUsd) || !(market.priceUsd! > 0)) return "no valid DEX price";
  if (!Number.isFinite(market.liquidityUsd) || !(market.liquidityUsd! >= MIN_LISTING_LIQUIDITY_USD)) return "insufficient DEX liquidity for the minimum trade";
  if (!Number.isFinite(market.updatedAt) || market.updatedAt > now || now - market.updatedAt > LISTING_MARKET_MAX_AGE_MS) return "DEX market data is stale";
  return null;
}

/** Read-only route probes: no approvals, calldata submission or wallet transactions. */
export async function hasTwoWayStockRoute(address: Address, decimals: number): Promise<boolean> {
  return cached(`stock:route:v1:${address.toLowerCase()}:${decimals}`, { ttlMs: 5 * 60_000, shared: true, isPartial: (value) => value === false, partialTtlMs: 60_000 }, async () => {
    // No taker-specific balance requirements and no region-restricted 0x API in a public probe.
    const providers = getTradeProviders({ orders: false, zeroX: false });
    const quote = (intent: TradeIntent): Promise<IndicativeQuote> => raceWithFallback(providers.map((provider) => async () => {
      const q = await provider.getIndicativeQuote(intent);
      if (!q.liquidityAvailable || q.buyAmount <= 0n || q.sellAmount !== intent.sellAmount || q.sellToken.toLowerCase() !== intent.sellToken.toLowerCase() || q.buyToken.toLowerCase() !== intent.buyToken.toLowerCase()) throw new Error("No usable stock route");
      return q;
    }), { hedgeDelayMs: 1_200 });
    try {
      const buy = await quote({ chainId: BASE_CHAIN_ID, side: "buy", assetAddress: address, sellToken: USDC_ADDRESS, buyToken: address, sellAmount: parseUnits(String(MIN_TRADE_USD), USDC_DECIMALS), sellTokenDecimals: USDC_DECIMALS, buyTokenDecimals: decimals, slippageBps: DEFAULT_SLIPPAGE_BPS });
      await quote({ chainId: BASE_CHAIN_ID, side: "sell", assetAddress: address, sellToken: address, buyToken: USDC_ADDRESS, sellAmount: buy.buyAmount, sellTokenDecimals: decimals, buyTokenDecimals: USDC_DECIMALS, slippageBps: DEFAULT_SLIPPAGE_BPS });
      return true;
    } catch {
      return false;
    }
  });
}

/** Bound provider fan-out while checking a whole catalog. */
export async function filterWithConcurrency<T>(items: T[], predicate: (item: T) => Promise<boolean>, concurrency = 6): Promise<T[]> {
  const accepted = new Array<boolean>(items.length).fill(false);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      accepted[index] = await predicate(items[index]);
    }
  }));
  return items.filter((_, index) => accepted[index]);
}

import type { TradeProvider } from "@/domain/trade";
import { ZeroXTradeProvider, zeroXProvider } from "./zero-x/adapter";
import { kyberProvider } from "./kyber/adapter";
import { OkxTradeProvider, okxProvider } from "./okx/adapter";
import { UniswapTradeProvider, uniswapProvider } from "./uniswap/adapter";
import { veloraProvider } from "./velora/adapter";
import { aerodromeTradeProvider } from "./aerodrome/adapter";
import { cowProvider } from "./cow/adapter";

export { isKnownTarget, knownTargets } from "./targets";
export { COMPARE_TIMEOUT_MS, INDICATIVE_TIMEOUT_MS } from "./budget";

/**
 * Ordered provider chain with hedged fallback (lib/fallback.ts):
 * 0x (when configured and not refusing the asset) → KyberSwap → OKX (when keys are set and entitled) → Uniswap Trading API (when a key is set) → Velora → Aerodrome direct route → CoW Protocol.
 * Unconfigured providers are skipped; the browser never sees which one answered.
 *
 * CoW is a signed-order flow (no transaction, solver pays gas), so it stays last in the fallback
 * chain: it is chosen when it wins the comparison or the user picks it, never as a surprise
 * substitute for a swap transaction. `orders: false` leaves it out entirely (basket legs).
 */
export function getTradeProviders(opts: { orders?: boolean; zeroX?: boolean } = {}): TradeProvider[] {
  const list: TradeProvider[] = [];
  // 0x's API terms exclude US persons; the router drops it for US requests (zeroX: false).
  if (opts.zeroX !== false && ZeroXTradeProvider.isConfigured()) list.push(zeroXProvider);
  list.push(kyberProvider);
  if (OkxTradeProvider.isUsable()) list.push(okxProvider);
  if (UniswapTradeProvider.isConfigured()) list.push(uniswapProvider);
  list.push(veloraProvider, aerodromeTradeProvider);
  if (opts.orders !== false) list.push(cowProvider);
  return list;
}

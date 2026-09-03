import type { TradeProvider } from "@/domain/trade";
import { ZeroXTradeProvider, zeroXProvider } from "./zero-x/adapter";
import { kyberProvider } from "./kyber/adapter";
import { OkxTradeProvider, okxProvider } from "./okx/adapter";
import { UniswapTradeProvider, uniswapProvider } from "./uniswap/adapter";
import { veloraProvider } from "./velora/adapter";
import { aerodromeTradeProvider } from "./aerodrome/adapter";

/**
 * Ordered provider chain with hedged fallback (lib/fallback.ts):
 * 0x (when configured and not refusing the asset) → KyberSwap → OKX (when keys are set and entitled) → Uniswap Trading API (when a key is set) → Velora → Aerodrome direct route.
 * Unconfigured providers are skipped; the browser never sees which one answered.
 */
export function getTradeProviders(): TradeProvider[] {
  const list: TradeProvider[] = [];
  if (ZeroXTradeProvider.isConfigured()) list.push(zeroXProvider);
  list.push(kyberProvider);
  if (OkxTradeProvider.isUsable()) list.push(okxProvider);
  if (UniswapTradeProvider.isConfigured()) list.push(uniswapProvider);
  list.push(veloraProvider, aerodromeTradeProvider);
  return list;
}

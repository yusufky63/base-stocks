import { route, json } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { aiConfigFromEnv } from "@/lib/ai-provider";
import { getTradeProviders } from "@/providers/trading";
import { zeroXUnauthorizedAssets, zeroXStatus } from "@/providers/trading/zero-x/adapter";
import { marketDataConfigured, marketDataProviderId } from "@/services/market-service";
import { getRepos } from "@/db/repositories";
import { MIN_TRADE_USD, DEFAULT_SLIPPAGE_BPS } from "@/config/chain";

/** Public feature flags. Never includes secrets. */
export const GET = route({}, async () => {
  const env = serverEnv();
  return json(
    {
      aiEnabled: aiConfigFromEnv() !== null,
      tradeProviders: getTradeProviders().map((p) => p.id),
      /** Assets 0x currently refuses for legal reasons (served by the fallback provider). */
      zeroXUnauthorizedAssets: zeroXUnauthorizedAssets(),
      /** 0x tokenized-stock status: refused until 0x approves the integrator's opt-in. */
      zeroX: zeroXStatus(),
      geoblockCountries: (env.GEOBLOCK_COUNTRIES ?? "US").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
      marketDataEnabled: marketDataConfigured(),
      marketDataProvider: marketDataProviderId(),
      storage: getRepos().backend,
      minTradeUsd: MIN_TRADE_USD,
      defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
    },
    { cacheSeconds: 30 },
  );
});

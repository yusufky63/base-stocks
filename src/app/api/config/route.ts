import { route, json } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { aiConfigFromEnv } from "@/lib/ai-provider";
import { getTradeProviders } from "@/providers/trading";
import { zeroXUnauthorizedAssets, zeroXStatus } from "@/providers/trading/zero-x/adapter";
import { marketDataProviderId } from "@/services/market-service";
import { getRepos } from "@/db/repositories";
import { MIN_TRADE_USD, DEFAULT_SLIPPAGE_BPS } from "@/config/chain";
import { isGateSignerConfigured } from "@/lib/pool/gate";
import { GIFT_POOL_ADDRESS, LEGACY_GIFT_POOL_ADDRESSES, isPoolDeployed } from "@/lib/pool";
import { GIFT_ESCROW_ADDRESS, LEGACY_GIFT_ESCROW_ADDRESSES } from "@/lib/escrow";
import { isAutoInvestDeployed, AUTO_INVEST_ADDRESS } from "@/lib/auto-invest";
import { isKeeperConfigured, keeperAddress } from "@/lib/viem/keeper-client";

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
      /** Always on: the keyless providers need no key. Kept for clients that still read the flag. */
      marketDataEnabled: true,
      marketDataProvider: marketDataProviderId(),
      /** Quest-gated pools need a campaign signer; without one the app hides that option
       *  instead of letting someone build a campaign that fails at the last step. */
      poolQuestsEnabled: isGateSignerConfigured(),
      /** The contracts new gifts and pools go to, and the earlier deployments whose records still resolve. */
      giftEscrow: { address: GIFT_ESCROW_ADDRESS, legacy: LEGACY_GIFT_ESCROW_ADDRESSES },
      giftPool: { address: isPoolDeployed() ? GIFT_POOL_ADDRESS : null, legacy: LEGACY_GIFT_POOL_ADDRESSES },
      /** AutoInvest: plans that run without the owner present. `keeperConfigured` false means owners run due plans themselves. */
      autoInvest: { enabled: isAutoInvestDeployed(), address: isAutoInvestDeployed() ? AUTO_INVEST_ADDRESS : null, keeperConfigured: isKeeperConfigured(), keeper: keeperAddress() },
      // Card top-ups need the CDP credentials the x402 facilitator already uses; without them the
      // tile would open a route that can only answer 503.
      onramp: !!process.env.CDP_API_KEY_ID?.trim() && !!process.env.CDP_API_KEY_SECRET?.trim(),
      storage: getRepos().backend,
      minTradeUsd: MIN_TRADE_USD,
      defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
    },
    { cacheSeconds: 30 },
  );
});

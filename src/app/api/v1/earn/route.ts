import { discoverUsdcEarn } from "@/services/earn-opportunity-service";
import { v1Json, v1Options } from "@/lib/api-v1/respond";

export const maxDuration = 60;

/**
 * Where idle USDC can earn on Base, discovered at runtime from the venues themselves — nothing is
 * listed unless the protocol really has a market. Rates are variable and never guaranteed.
 */
export async function GET(): Promise<Response> {
  const disc = await discoverUsdcEarn();
  return v1Json(
    {
      asset: disc.assetAddress,
      count: disc.opportunities.length,
      opportunities: disc.opportunities.map((o) => ({
        id: o.id,
        provider: o.provider,
        title: o.title,
        type: o.type,
        variableApyPct: o.variableApy ?? null,
        rewardsAprPct: o.rewardsApr ?? null,
        tvlUsd: o.tvlUsd ?? null,
        riskLabel: o.riskLabel,
        risks: o.risks,
        /** True when a deposit can be built inside the app rather than at the venue. */
        inApp: o.inApp,
        url: o.url ?? null,
        dataTimestamp: o.dataTimestamp,
      })),
      unavailableProviders: disc.unavailableProviders,
    },
    { cacheSeconds: 120, staleSeconds: 900 },
  );
}

export const OPTIONS = v1Options;

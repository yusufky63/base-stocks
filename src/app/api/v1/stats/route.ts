import { getPlatformStats } from "@/services/stats-service";
import { v1Json, v1Options } from "@/lib/api-v1/respond";

export const maxDuration = 60;

/**
 * What has been done through the app, counted from records the server verified against a receipt
 * on Base — not from anything self-reported.
 */
export async function GET(): Promise<Response> {
  const s = await getPlatformStats();
  return v1Json(
    {
      generatedAt: s.generatedAt,
      windows: s.windows,
      trading: { byProvider: s.trading.byProvider, byAsset: s.trading.byAsset },
      strategies: s.strategies,
      gifts: s.gifts,
      earn: { deposits: s.earn.deposits, withdrawals: s.earn.withdrawals, byProvider: s.earn.byProvider },
    },
    { cacheSeconds: 300, staleSeconds: 1_800 },
  );
}

export const OPTIONS = v1Options;

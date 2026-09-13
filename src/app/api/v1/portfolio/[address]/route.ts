import { isAddress, type Address } from "viem";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { v1Error, v1Json, v1Options } from "@/lib/api-v1/respond";
import { enforceDurableRateLimit } from "@/lib/rate-limit";
import { AppError } from "@/lib/errors";

export const maxDuration = 60;

/**
 * Any wallet's tokenized-stock position, read from the chain.
 *
 * Public because the chain is: this endpoint reveals nothing a block explorer does not. It is
 * priced per wallet rather than shared, so it caches for fifteen seconds only — long enough to
 * absorb a burst, short enough to stay useful after a trade.
 *
 * Both `rawBalance` and `shares` are returned: they differ by the token's multiplier, and a
 * caller that treats one as the other will be wrong after any split or dividend.
 */
export async function GET(req: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  // Per wallet there is no cache to hide behind, so each call is chain reads; the window counter is
  // shared across instances because a public endpoint is what a scraper finds first.
  try {
    await enforceDurableRateLimit(req, "v1.portfolio", { limit: 60, windowMs: 60_000 });
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") return v1Error(429, "RATE_LIMITED", "Too many requests from this address. Sixty a minute is the limit.");
    throw err;
  }
  const { address } = await params;
  if (!isAddress(address)) return v1Error(400, "BAD_ADDRESS", "Pass a 0x-prefixed 20-byte address.");
  const s = await getPortfolioSnapshot(address as Address);
  return v1Json(
    {
      owner: s.owner,
      totalValueUsd: s.totalValueUsd,
      change24hPct: s.change24hPct ?? null,
      usdc: { raw: s.usdcBalance, valueUsd: s.usdcValueUsd },
      earnValueUsd: s.earnValueUsd,
      liquidityValueUsd: s.lpValueUsd,
      holdings: s.holdings.map((h) => ({
        address: h.assetAddress,
        symbol: h.underlying,
        rawBalance: h.rawBalance,
        /** Share-equivalents: rawBalance × multiplier ÷ 1e18. */
        shares: h.scaledBalance,
        decimals: h.decimals,
        multiplier: h.multiplier,
        priceUsd: h.priceUsd,
        priceSource: h.priceSource,
        valueUsd: h.marketValueUsd,
        change24hPct: h.change24hPct ?? null,
        weightBps: h.currentWeightBps ?? null,
      })),
      readAt: s.readAt,
    },
    { cacheSeconds: 15, staleSeconds: 120 },
  );
}

export const OPTIONS = v1Options;

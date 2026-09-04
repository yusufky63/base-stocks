import { z } from "zod";
import { route, json, parseBody, addressSchema, bigintStringSchema } from "@/lib/api";
import { tradeRouter } from "@/services/trade-router";
import { requestCountry } from "@/lib/geo";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

const bodySchema = z.object({
  side: z.enum(["buy", "sell"]),
  /** Buys can be paid in USDC (default) or native ETH; sells always receive USDC. */
  payWith: z.enum(["USDC", "ETH"]).optional(),
  assetAddress: addressSchema,
  sellAmount: bigintStringSchema,
  taker: addressSchema,
  recipient: addressSchema.optional(),
  slippageBps: z.number().int().min(1).max(5000).optional(),
  chainId: z.number().int().optional(),
  provider: z.enum(["zeroX", "kyber", "okx", "uniswap", "velora", "aerodrome", "cow"]).optional(),
  /** false = transactions only (no signed orders); basket legs need a transaction hash per leg. */
  orders: z.boolean().optional(),
  /** Manual choice from the comparison: use exactly this provider, no fallback. */
  strictProvider: z.boolean().optional(),
});

/** Firm executable quote. Short-lived; never long-cached. */
export const POST = route({ rateLimit: { key: "trade.quote", limit: 40, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, bodySchema);
  const quote = await tradeRouter.quote({ ...body, noZeroX: requestCountry(req) === "US" });
  return json(quote);
});

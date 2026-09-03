import { z } from "zod";
import { route, json, parseBody, addressSchema, bigintStringSchema } from "@/lib/api";
import { tradeRouter } from "@/services/trade-router";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

const bodySchema = z.object({
  side: z.enum(["buy", "sell"]),
  /** Buys can be paid in USDC (default) or native ETH; sells always receive USDC. */
  payWith: z.enum(["USDC", "ETH"]).optional(),
  assetAddress: addressSchema,
  sellAmount: bigintStringSchema,
  taker: addressSchema.optional(),
  recipient: addressSchema.optional(),
  slippageBps: z.number().int().min(1).max(5000).optional(),
  chainId: z.number().int().optional(),
  provider: z.enum(["zeroX", "kyber", "okx", "uniswap", "velora", "aerodrome"]).optional(),
});

/** Indicative price. Browser → this route → 0x/Kyber (keys stay server-side). */
export const POST = route({ rateLimit: { key: "trade.price", limit: 120, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, bodySchema);
  const summary = await tradeRouter.price(body);
  return json(summary);
});

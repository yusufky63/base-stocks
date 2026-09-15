import { z } from "zod";
import { route, json, parseBody, addressSchema, bigintStringSchema } from "@/lib/api";
import { tradeRouter } from "@/services/trade-router";
import { requestCountry, assertTradingAllowed } from "@/lib/geo";
import { enforceDurableRateLimit } from "@/lib/rate-limit";

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
  /** Capped at 10%: anything wider is a minimum output so loose it protects nobody. */
  slippageBps: z.number().int().min(1).max(1000).optional(),
  chainId: z.number().int().optional(),
  provider: z.enum(["zeroX", "kyber", "okx", "uniswap", "velora", "aerodrome", "cow"]).optional(),
  /** false = transactions only (no signed orders); basket legs need a transaction hash per leg. */
  orders: z.boolean().optional(),
  /** Manual choice from the comparison: use exactly this provider, no fallback. */
  strictProvider: z.boolean().optional(),
  /** Prefer CoW's batch auction: asked first for the firm quote, the swap chain covers a miss. */
  bestExecution: z.boolean().optional(),
});

/**
 * A second durable window, keyed by the taker. The route-level limit is per IP and lived in one
 * instance's memory, so it reset on every cold start and one wallet asking from rotating addresses
 * never met it, while everyone behind one office IP shared it. The limiter keys on the client
 * address it reads from the request headers; the taker is handed to it as that address.
 */
const TAKER_WINDOW = { limit: 40, windowMs: 60_000 };
async function enforceTakerWindow(req: Request, taker: string): Promise<void> {
  const asTaker = new Request(req.url, { method: req.method, headers: { "x-forwarded-for": taker, "x-real-ip": taker } });
  await enforceDurableRateLimit(asTaker, "trade.quote.taker", TAKER_WINDOW);
}

/** Firm executable quote. Short-lived; never long-cached. */
export const POST = route({ rateLimit: { key: "trade.quote", limit: 40, windowMs: 60_000, durable: true } }, async (req) => {
  assertTradingAllowed(req);
  const body = await parseBody(req, bodySchema);
  await enforceTakerWindow(req, body.taker);
  const quote = await tradeRouter.quote({ ...body, noZeroX: requestCountry(req) === "US" });
  return json(quote);
});

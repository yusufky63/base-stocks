import { z } from "zod";
import type { Address, Hex } from "viem";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { appDataFor, listOrders, submitOrder } from "@/providers/trading/cow/adapter";
import type { SignedOrderRequest } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { b20Guard } from "@/services/b20-guard-service";
import { USDC_ADDRESS } from "@/config/chain";

/** Serverless budget: the order book can take a few seconds to validate a signed order. */
export const maxDuration = 30;

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const messageSchema = z.object({
  sellToken: addressSchema,
  buyToken: addressSchema,
  receiver: addressSchema,
  sellAmount: z.string().regex(/^\d+$/),
  buyAmount: z.string().regex(/^\d+$/),
  validTo: z.number().int().positive(),
  appData: hex,
  feeAmount: z.literal("0"),
  kind: z.enum(["sell", "buy"]),
  partiallyFillable: z.boolean(),
  sellTokenBalance: z.literal("erc20"),
  buyTokenBalance: z.literal("erc20"),
});

const submitSchema = z.object({
  from: addressSchema,
  signature: hex,
  signingScheme: z.enum(["eip712", "eip1271", "presign"]),
  order: z.object({
    provider: z.literal("cow"),
    orderClass: z.enum(["market", "limit"]),
    typedData: z.object({ domain: z.object({ name: z.string(), version: z.string(), chainId: z.number(), verifyingContract: addressSchema }), types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))), primaryType: z.literal("Order"), message: messageSchema }),
    appData: z.string().max(1000),
    appDataHash: hex,
    quoteId: z.number().nullable(),
    allowanceTarget: addressSchema,
  }),
});

type SubmittedOrder = z.infer<typeof submitSchema>["order"];

/**
 * The app-data document is recomputed here, not relayed. It carries the integrator fee
 * (`partnerFee`), and a client allowed to send its own document could send one without the fee, or
 * with another recipient, and the order book would take it as long as the hash matched. The client
 * chooses only what the document legitimately varies by, the order class and, for a market order,
 * the slippage it was quoted with; the rest is this server's, and the signed hash has to be the
 * hash of what this server issues.
 */
export function verifyAppData(order: Pick<SubmittedOrder, "orderClass" | "appData" | "appDataHash"> & { typedData: { message: { appData: string } } }): void {
  let slippageBips = 0;
  if (order.orderClass === "market") {
    let doc: unknown;
    try {
      doc = JSON.parse(order.appData);
    } catch {
      throw new AppError("BAD_REQUEST", "The order's app data is not a JSON document.", 400);
    }
    const bips = (doc as { metadata?: { quote?: { slippageBips?: unknown } } } | null)?.metadata?.quote?.slippageBips;
    if (typeof bips !== "number" || !Number.isInteger(bips) || bips < 0 || bips > 10_000) throw new AppError("BAD_REQUEST", "The order's app data does not carry the slippage it was quoted with.", 400);
    slippageBips = bips;
  }
  const expected = appDataFor(order.orderClass, slippageBips);
  const hash = expected.hash.toLowerCase();
  if (expected.doc !== order.appData || order.appDataHash.toLowerCase() !== hash || order.typedData.message.appData.toLowerCase() !== hash) {
    throw new AppError("BAD_REQUEST", "The order's app data is not what this server issues; refresh the quote and sign again.", 400);
  }
}

/**
 * Submit a signed CoW order. The browser signed exactly what /api/trade/quote (or /prepare) returned;
 * the app data is checked against what this server would have issued, and the order book
 * re-validates signature, balance and allowance before accepting it.
 */
export const POST = route({ rateLimit: { key: "orders.submit", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, submitSchema);
  verifyAppData(body.order);
  const m = body.order.typedData.message;
  const buy = m.sellToken.toLowerCase() === USDC_ADDRESS.toLowerCase();
  // A sale pays its USDC to the wallet that sold; a receiver elsewhere is a transfer dressed as a trade.
  if (!buy && m.receiver.toLowerCase() !== body.from.toLowerCase()) throw new AppError("BAD_REQUEST", "A sale pays its proceeds to the wallet that sells; a recipient can only be set on a buy.", 400);
  // Same guard as a swap: canonical asset, transfer state, issuer policy for owner and receiver.
  await b20Guard.preTradeCheck({ assetAddress: (buy ? m.buyToken : m.sellToken) as Address, side: buy ? "buy" : "sell", taker: body.from as Address, recipient: m.receiver !== body.from ? (m.receiver as Address) : undefined });
  const uid = await submitOrder(body.order as SignedOrderRequest, body.signature as Hex, body.signingScheme, body.from as Address);
  return json({ uid, explorerUrl: `https://explorer.cow.fi/base/orders/${uid}` }, { status: 201 });
});

/** The owner's recent orders, newest first (open and settled). */
export const GET = route({ rateLimit: { key: "orders.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner, limit } = parseQuery(req, z.object({ owner: addressSchema, limit: z.coerce.number().int().min(1).max(100).default(20) }));
  return json({ orders: await listOrders(owner as Address, limit) });
});

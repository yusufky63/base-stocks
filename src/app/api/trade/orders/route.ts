import { z } from "zod";
import type { Address, Hex } from "viem";
import { route, json, parseBody, parseQuery, addressSchema } from "@/lib/api";
import { listOrders, submitOrder } from "@/providers/trading/cow/adapter";
import type { SignedOrderRequest } from "@/domain/trade";
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

/**
 * Submit a signed CoW order. The browser signed exactly what /api/trade/quote (or /prepare) returned;
 * the order book re-validates signature, balance and allowance before accepting it.
 */
export const POST = route({ rateLimit: { key: "orders.submit", limit: 20, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, submitSchema);
  const m = body.order.typedData.message;
  const buy = m.sellToken.toLowerCase() === USDC_ADDRESS.toLowerCase();
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

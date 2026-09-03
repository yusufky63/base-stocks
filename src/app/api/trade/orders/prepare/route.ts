import { z } from "zod";
import type { Address } from "viem";
import { route, json, parseBody, addressSchema, bigintStringSchema } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { USDC_ADDRESS } from "@/config/chain";
import { b20Guard } from "@/services/b20-guard-service";
import { MAX_ORDER_VALID_FOR_S, prepareLimitOrder } from "@/providers/trading/cow/adapter";

const bodySchema = z.object({
  side: z.enum(["buy", "sell"]),
  assetAddress: addressSchema,
  /** Base units sold: USDC for a buy, the stock for a sell. */
  sellAmount: bigintStringSchema,
  /** Base units the user wants at minimum: the stock for a buy, USDC for a sell. */
  minBuyAmount: bigintStringSchema,
  owner: addressSchema,
  recipient: addressSchema.optional(),
  validForSeconds: z.number().int().min(60).max(MAX_ORDER_VALID_FOR_S),
});

/**
 * Build the EIP-712 payload of a limit order. No provider quote is involved: the user sets the
 * price; the B20 guard still runs so a paused or policy-blocked stock is refused before signing.
 */
export const POST = route({ rateLimit: { key: "orders.prepare", limit: 60, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, bodySchema);
  if (body.sellAmount <= 0n || body.minBuyAmount <= 0n) throw new AppError("AMOUNT_TOO_SMALL", "Enter an amount and a limit price.", 400);
  const { asset, warnings } = await b20Guard.preTradeCheck({ assetAddress: body.assetAddress as Address, side: body.side, taker: body.owner as Address, recipient: body.recipient as Address | undefined });
  const buy = body.side === "buy";
  const order = prepareLimitOrder({
    sellToken: buy ? USDC_ADDRESS : asset.address,
    buyToken: buy ? asset.address : USDC_ADDRESS,
    sellAmount: body.sellAmount,
    minBuyAmount: body.minBuyAmount,
    owner: body.owner as Address,
    receiver: body.recipient as Address | undefined,
    validForSeconds: body.validForSeconds,
  });
  return json({ order, warnings });
});

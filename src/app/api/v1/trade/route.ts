import { z } from "zod";
import { addressSchema } from "@/lib/api";
import { BUILDER_CODE, V1_TRADE_LIMIT, tradeCalls } from "@/lib/api-v1/trade";
import { findStock } from "@/lib/api-v1/shape";
import { v1Error, v1Json, v1Options } from "@/lib/api-v1/respond";
import { AppError } from "@/lib/errors";
import { assertTradingAllowed, requestCountry } from "@/lib/geo";
import { enforceDurableRateLimit } from "@/lib/rate-limit";
import { TRADE_PROVIDER_IDS } from "@/domain/trade";
import { getAssets } from "@/services/b20-asset-service";
import { tradeRouter } from "@/services/trade-router";

export const maxDuration = 60;

/** Signed-order routes (CoW) are left out: this endpoint returns transactions, each with a hash. */
const PROVIDERS = TRADE_PROVIDER_IDS.filter((p) => p !== "cow") as [string, ...string[]];

const bodySchema = z.object({
  stock: z.string().trim().min(1).max(64),
  side: z.enum(["buy", "sell"]),
  /** Smallest unit of what is sold: USDC (6 decimals) or ETH (18) on a buy, the stock's own on a sell. */
  amount: z.string().regex(/^[1-9]\d{0,38}$/),
  account: addressSchema,
  recipient: addressSchema.optional(),
  payWith: z.enum(["USDC", "ETH"]).optional(),
  slippageBps: z.number().int().min(10).max(500).optional(),
  provider: z.enum(PROVIDERS).optional(),
  builderCode: z.string().regex(BUILDER_CODE).optional(),
});

/** The account's own window, beside the caller's: a wallet asking from many addresses still meets one. */
async function enforceAccountWindow(req: Request, account: string): Promise<void> {
  const asAccount = new Request(req.url, { method: req.method, headers: { "x-forwarded-for": account, "x-real-ip": account } });
  await enforceDurableRateLimit(asAccount, "v1.trade.account", V1_TRADE_LIMIT);
}

/**
 * The calls for one trade, for the account that will send them: an approval of exactly the amount
 * sold when the allowance is short, then the swap, from the same router and providers the app's
 * own trade panel uses. Nothing is signed or sent here.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    await enforceDurableRateLimit(req, "v1.trade", V1_TRADE_LIMIT);
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return v1Error(400, "BAD_BODY", "Send a JSON body.");
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return v1Error(400, "BAD_BODY", "stock, side, amount and account are required.", "amount is an integer string in the smallest unit of what is sold; slippageBps is 10 to 500.");
    }
    const body = parsed.data;
    const assets = await getAssets();
    const asset = findStock(assets, body.stock);
    if (!asset) {
      return v1Error(404, "UNKNOWN_STOCK", `No listed stock matches "${body.stock.slice(0, 12)}".`, `Try one of: ${assets.map((a) => a.underlying).join(", ")}`);
    }
    assertTradingAllowed(req);
    await enforceAccountWindow(req, body.account);

    const quote = await tradeRouter.quote({
      side: body.side,
      payWith: body.side === "buy" ? body.payWith : undefined,
      assetAddress: asset.address,
      sellAmount: BigInt(body.amount),
      taker: body.account,
      recipient: body.recipient,
      slippageBps: body.slippageBps,
      provider: body.provider as (typeof TRADE_PROVIDER_IDS)[number] | undefined,
      orders: false,
      noZeroX: requestCountry(req) === "US",
    });
    const built = tradeCalls(quote, body.builderCode);
    if (!built) return v1Error(409, "NO_ROUTE", "No route returned a transaction for this trade right now.", "Try again, or a different amount.");

    return v1Json(
      {
        stock: { symbol: asset.underlying, tokenSymbol: asset.symbol, address: asset.address },
        side: body.side,
        account: body.account,
        recipient: body.recipient ?? body.account,
        provider: quote.provider,
        quote: {
          sellToken: quote.sellToken,
          buyToken: quote.buyToken,
          sellAmount: quote.sellAmount,
          buyAmount: quote.buyAmount,
          minBuyAmount: quote.minBuyAmount,
          priceUsd: quote.executablePriceUsd,
          pricePerShareUsd: quote.executablePricePerShareUsd,
          priceImpactPct: quote.priceImpactPct,
          networkFeeUsd: quote.estimatedNetworkFeeUsd,
          integratorFee: quote.integratorFee,
          balanceInsufficient: quote.balanceInsufficient,
          warnings: quote.warnings,
        },
        approval: built.approval,
        calls: built.calls,
        quoteId: quote.quoteId,
        expiresAt: new Date(quote.expiresAt).toISOString(),
      },
      { cacheSeconds: 0 },
    );
  } catch (err) {
    if (err instanceof AppError) return v1Error(err.httpStatus, err.code, err.message);
    return v1Error(502, "TRADE_FAILED", "The trade could not be built right now.");
  }
}

export const OPTIONS = v1Options;

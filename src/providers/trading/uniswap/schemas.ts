import { z } from "zod";

/** Response shapes of the Uniswap Trading API (trade-api.gateway.uniswap.org/v1), proxy-approval flow. */
const amountSchema = z.object({ amount: z.string(), token: z.string().optional(), minimumAmount: z.string().optional(), maximumAmount: z.string().optional() });

export const uniswapQuoteResponseSchema = z.object({
  requestId: z.string().optional(),
  routing: z.string(),
  permitData: z.unknown().nullable().optional(),
  isTokenApprovalApplicable: z.boolean().optional(),
  quote: z
    .object({
      input: amountSchema,
      output: amountSchema,
      gasFee: z.string().optional(),
      gasFeeUSD: z.union([z.string(), z.number()]).optional(),
      gasUseEstimate: z.union([z.string(), z.number()]).optional(),
      priceImpact: z.number().optional(),
      quoteId: z.string().optional(),
      routeString: z.string().optional(),
      route: z.array(z.array(z.object({ type: z.string().optional(), fee: z.union([z.string(), z.number()]).optional() }).passthrough())).optional(),
    })
    .passthrough(),
});

export const uniswapSwapResponseSchema = z.object({
  requestId: z.string().optional(),
  gasFee: z.string().optional(),
  swap: z.object({ to: z.string(), from: z.string().optional(), data: z.string().regex(/^0x[0-9a-fA-F]*$/), value: z.string().optional(), gasLimit: z.string().optional(), chainId: z.number().optional(), maxFeePerGas: z.string().optional() }),
});

export const uniswapApprovalResponseSchema = z.object({ approval: z.object({ to: z.string(), data: z.string() }).nullable().optional() });

export const uniswapErrorSchema = z.object({ errorCode: z.string().optional(), detail: z.string().optional() });

export type UniswapQuoteResponse = z.infer<typeof uniswapQuoteResponseSchema>;

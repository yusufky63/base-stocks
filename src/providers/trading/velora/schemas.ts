import { z } from "zod";

/** Response shapes of the Velora (ParaSwap) Market API v6.2: GET /prices and POST /transactions/{chainId}. */
const bigStr = z.union([z.string(), z.number()]).transform((v) => String(v));

export const veloraPriceRouteSchema = z
  .object({
    srcAmount: bigStr,
    destAmount: bigStr,
    tokenTransferProxy: z.string(),
    contractAddress: z.string().optional(),
    gasCost: bigStr.optional(),
    gasCostUSD: bigStr.optional(),
    bestRoute: z
      .array(
        z
          .object({
            percent: z.number().optional(),
            swaps: z.array(z.object({ swapExchanges: z.array(z.object({ exchange: z.string(), percent: z.number().optional() }).passthrough()).optional() }).passthrough()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const veloraPricesSchema = z.object({ priceRoute: veloraPriceRouteSchema.optional(), error: z.string().optional() });

export const veloraTxSchema = z.object({ to: z.string(), data: z.string().regex(/^0x[0-9a-fA-F]*$/), value: bigStr.optional(), gas: bigStr.optional(), gasPrice: bigStr.optional(), error: z.string().optional() });

export type VeloraPriceRoute = z.infer<typeof veloraPriceRouteSchema>;

import { z } from "zod";

const bigStr = z.union([z.string(), z.number()]).transform((v) => String(v));

export const kyberRouteSummarySchema = z
  .object({
    tokenIn: z.string(),
    amountIn: bigStr,
    amountInUsd: bigStr.optional(),
    tokenOut: z.string(),
    amountOut: bigStr,
    amountOutUsd: bigStr.optional(),
    gas: bigStr.optional(),
    gasPrice: bigStr.optional(),
    gasUsd: bigStr.optional(),
    routeID: z.string().optional(),
    checksum: z.string().optional(),
    timestamp: z.number().optional(),
    route: z
      .array(
        z.array(
          z
            .object({
              exchange: z.string().optional(),
              poolType: z.string().optional(),
              swapAmount: bigStr.optional(),
            })
            .passthrough(),
        ),
      )
      .optional(),
  })
  .passthrough();

export const kyberRoutesResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      routeSummary: kyberRouteSummarySchema.nullable(),
      routerAddress: z.string(),
    })
    .nullable()
    .optional(),
});

export const kyberBuildResponseSchema = z.object({
  code: z.number(),
  message: z.string().optional(),
  data: z
    .object({
      amountIn: bigStr.optional(),
      amountOut: bigStr.optional(),
      gas: bigStr.optional(),
      gasUsd: bigStr.optional(),
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
      routerAddress: z.string(),
      transactionValue: bigStr.optional(),
    })
    .nullable()
    .optional(),
});

export type KyberRouteSummary = z.infer<typeof kyberRouteSummarySchema>;

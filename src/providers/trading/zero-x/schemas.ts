import { z } from "zod";

const bigStr = z.union([z.string(), z.number()]).transform((v) => String(v));
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const zeroXIssuesSchema = z
  .object({
    allowance: z.object({ actual: bigStr.nullable(), spender: addr }).nullable().optional(),
    balance: z.object({ token: z.string(), actual: bigStr.nullable(), expected: bigStr.nullable() }).nullable().optional(),
    simulationIncomplete: z.boolean().optional(),
    invalidSourcesPassed: z.array(z.string()).optional(),
  })
  .partial();

export const zeroXRouteSchema = z
  .object({
    fills: z.array(z.object({ source: z.string(), proportionBps: z.union([z.number(), z.string()]).nullable().optional() })).optional(),
    tokens: z.array(z.object({ address: z.string(), symbol: z.string().optional() })).optional(),
  })
  .partial();

/** Shared shape for /price and /quote (v2 AllowanceHolder). */
export const zeroXPriceSchema = z.object({
  liquidityAvailable: z.boolean(),
  zid: z.string().optional(),
  allowanceTarget: addr.nullable().optional(),
  buyToken: z.string().optional(),
  sellToken: z.string().optional(),
  buyAmount: bigStr.nullable().optional(),
  sellAmount: bigStr.nullable().optional(),
  minBuyAmount: bigStr.nullable().optional(),
  gas: bigStr.nullable().optional(),
  gasPrice: bigStr.nullable().optional(),
  totalNetworkFee: bigStr.nullable().optional(),
  issues: zeroXIssuesSchema.nullable().optional(),
  route: zeroXRouteSchema.nullable().optional(),
  blockNumber: bigStr.nullable().optional(),
});

export const zeroXQuoteSchema = zeroXPriceSchema.extend({
  transaction: z
    .object({
      to: addr,
      data: z.string().regex(/^0x[0-9a-fA-F]*$/),
      gas: bigStr.nullable().optional(),
      gasPrice: bigStr.nullable().optional(),
      value: bigStr.nullable().optional(),
    })
    .optional(),
});

export const zeroXErrorSchema = z.object({
  name: z.string().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});

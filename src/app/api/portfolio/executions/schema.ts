import { z } from "zod";
import { addressSchema, hashSchema } from "@/lib/api";

/**
 * One leg of a basket execution as the browser files it. Shared by the create and the patch
 * route so the two cannot drift apart.
 *
 * `targetUsd` is the browser's figure for the leg and has a ceiling: the statistics count a leg
 * only once a verified trade row for the same (transaction, stock, side) exists, but the
 * Activity page shows this number, and a record claiming a million-dollar leg should be refused
 * at the door rather than displayed.
 */
export const MAX_LEG_USD = 100_000;

export const stepSchema = z.object({
  id: z.string().min(4).max(64),
  assetAddress: addressSchema,
  symbol: z.string().max(16),
  side: z.enum(["buy", "sell"]).default("buy"),
  targetUsd: z.number().nonnegative().max(MAX_LEG_USD),
  sellAmountUsdc: z.string().regex(/^\d+$/),
  sellAmount: z.string().regex(/^\d+$/).optional(),
  provider: z.string().max(32).optional(),
  status: z.enum(["pending", "quoted", "submitted", "confirmed", "failed"]),
  txHash: hashSchema.optional(),
  errorCode: z.string().max(64).optional(),
  errorMessage: z.string().max(300).optional(),
});

export type StepInput = z.infer<typeof stepSchema>;

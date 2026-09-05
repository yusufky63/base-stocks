import { z } from "zod";
import { formatUnits, type Hash } from "viem";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos, type EarnActionRecord } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { USDC_DECIMALS } from "@/config/chain";
import { verdictError, verifyEarn } from "@/services/tx-verify-service";

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  opportunityId: z.string().min(3).max(120),
  provider: z.string().max(32),
  /** `collect`: fees taken from a liquidity position (LP providers only). */
  action: z.enum(["deposit", "withdraw", "collect"]),
  amount: z.string().regex(/^\d+$/),
  usdValue: z.number().nullable(),
  txHash: hashSchema,
});

/**
 * App-side Earn records, matched to the venue's own event before they are kept: Aave, Morpho
 * and Compound name the wallet and the amount in `Supply`/`Deposit`/`Withdraw`; a liquidity
 * action is proven by the position manager acting and the wallet's tokens moving. A receipt that
 * is not in yet leaves the record pending for the verification sweep; one that contradicts the
 * record refuses it. The chain sweep (`earn-reconcile-service`) also files lending records the
 * browser never sent.
 */
export const POST = route({ rateLimit: { key: "earn.record", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const v = await verifyEarn({ txHash: body.txHash as Hash, owner: body.owner, provider: body.provider, action: body.action });
  if (!v.ok) {
    if (v.state === "pending") {
      const record: EarnActionRecord = { ...body, txHash: body.txHash as Hash, createdAt: Date.now() };
      await getRepos().earnActions.create(record);
      return json({ action: record, verification: "pending" }, { status: 201 });
    }
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  const amount = v.amount ?? BigInt(body.amount);
  const record: EarnActionRecord = {
    ...body,
    txHash: body.txHash as Hash,
    amount: amount.toString(),
    // Lending moves USDC only, so the chain's amount is the USD figure; a liquidity position has a stock leg the app priced.
    usdValue: v.amount !== null ? Math.round(Number(formatUnits(v.amount, USDC_DECIMALS)) * 100) / 100 : body.usdValue,
    createdAt: v.blockTime ? v.blockTime * 1000 : Date.now(),
    verifiedAt: Date.now(),
  };
  await getRepos().earnActions.create(record);
  return json({ action: record, verification: "verified" }, { status: 201 });
});

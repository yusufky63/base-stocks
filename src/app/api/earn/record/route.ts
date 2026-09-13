import { z } from "zod";
import { formatUnits, type Hash } from "viem";
import { route, json, parseBody, addressSchema, hashSchema } from "@/lib/api";
import { getRepos, type EarnActionRecord } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { USDC_ADDRESS, USDC_DECIMALS } from "@/config/chain";
import { sessionAddress } from "@/lib/auth/session";
import { boundedUsd } from "@/lib/trade/record-usd";
import type { TokenMove } from "@/lib/chain/receipt-checks";
import { getAssets } from "@/services/b20-asset-service";
import { estimateStockUsd } from "@/services/price-service";
import { verdictError, verifyEarn } from "@/services/tx-verify-service";
import { invalidateLpPositions } from "@/services/lp-positions-service";
import { invalidatePortfolioSnapshot } from "@/services/portfolio-service";

/** Lending venues and the two liquidity venues the app can prove a receipt against. */
const EARN_PROVIDERS = ["morpho", "aave", "compound", "uniswap", "aerodrome"] as const;

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  opportunityId: z.string().min(3).max(120),
  provider: z.enum(EARN_PROVIDERS),
  /** `collect`: fees taken from a liquidity position (LP providers only). */
  action: z.enum(["deposit", "withdraw", "collect"]),
  amount: z.string().regex(/^\d+$/),
  usdValue: z.number().nullable(),
  txHash: hashSchema,
});

/** Marks a record filed while its receipt was pending by a wallet that was signed in at the time, so the sweep can trust it the same way. */
export const EARN_FILED_BY_OWNER = "pending:signed-in";

/**
 * What the tokens that moved in a liquidity action are worth: the USDC as itself, each stock at
 * its price. A mint moves both legs out of the wallet, a collect moves both in; either way the
 * absolute amounts are the value the record may claim.
 */
export async function liquidityUsdEstimate(moves: readonly TokenMove[]): Promise<number | null> {
  if (moves.length === 0) return null;
  const assets = await getAssets().catch(() => []);
  let total = 0;
  let priced = false;
  for (const m of moves) {
    if (m.token.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
      total += Number(formatUnits(m.value, USDC_DECIMALS));
      priced = true;
      continue;
    }
    const asset = assets.find((a) => a.canonicalId === m.token.toLowerCase());
    if (!asset) continue;
    const usd = await estimateStockUsd(asset, m.value).catch(() => null);
    if (usd === null) continue;
    total += usd;
    priced = true;
  }
  return priced ? total : null;
}

/**
 * App-side Earn records, matched to the venue's own event before they are kept: Aave, Morpho
 * and Compound name the wallet and the amount in `Supply`/`Deposit`/`Withdraw`; a liquidity
 * action is proven by the position manager acting and the wallet's tokens moving. A receipt that
 * is not in yet leaves the record pending for the verification sweep; one that contradicts the
 * record refuses it. The chain sweep (`earn-reconcile-service`) also files lending records the
 * browser never sent.
 *
 * Who may file: the wallet's own session, or a request the receipt vouches for (the wallet sent
 * the transaction). A liquidity action's USD figure, which no venue event settles, is bounded by
 * what the tokens that moved are worth.
 */
export const POST = route({ rateLimit: { key: "earn.record", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const signedIn = sessionAddress(req);
  if (signedIn && signedIn.toLowerCase() !== body.owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "This action is only allowed for the signed-in wallet.", 403);
  const trusted = !!signedIn;
  const v = await verifyEarn({ txHash: body.txHash as Hash, owner: body.owner, provider: body.provider, action: body.action });
  if (!v.ok) {
    if (v.state === "pending") {
      const record: EarnActionRecord = { ...body, txHash: body.txHash as Hash, createdAt: Date.now(), ...(trusted ? { verifyNote: EARN_FILED_BY_OWNER } : {}) };
      await getRepos().earnActions.create(record);
      return json({ action: record, verification: "pending" }, { status: 201 });
    }
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  if (!trusted && !v.initiatedByOwner) throw new AppError("UNAUTHORIZED", "That transaction was not sent by this wallet. Sign in with the wallet to file it.", 401);
  const amount = v.amount ?? BigInt(body.amount);
  const record: EarnActionRecord = {
    ...body,
    txHash: body.txHash as Hash,
    amount: amount.toString(),
    // Lending moves USDC only, so the chain's amount is the USD figure; a liquidity position has a stock leg the app priced, bounded by what moved.
    usdValue: v.amount !== null ? Math.round(Number(formatUnits(v.amount, USDC_DECIMALS)) * 100) / 100 : boundedUsd(body.usdValue, await liquidityUsdEstimate(v.moves)),
    createdAt: v.blockTime ? v.blockTime * 1000 : Date.now(),
    verifiedAt: Date.now(),
  };
  await getRepos().earnActions.create(record);
  // The wallet's cached views are stale the moment its money moved; the versions live in the
  // shared store, so every serverless instance sees the bump.
  void invalidatePortfolioSnapshot(body.owner);
  if (body.provider === "uniswap" || body.provider === "aerodrome") await invalidateLpPositions(body.owner).catch(() => undefined);
  return json({ action: record, verification: "verified" }, { status: 201 });
});

import { z } from "zod";
import { formatUnits, type Hash } from "viem";
import { route, json, parseBody, parseQuery, addressSchema, hashSchema } from "@/lib/api";
import { getRepos, type TradeRecord } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { USDC_DECIMALS } from "@/config/chain";
import { invalidatePortfolioSnapshot } from "@/services/portfolio-service";
import { verdictError, verifyTrade } from "@/services/tx-verify-service";
import { getServerPublicClient } from "@/lib/viem/server-client";

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  side: z.enum(["buy", "sell"]),
  assetAddress: addressSchema,
  sellAmount: z.string().regex(/^\d+$/),
  buyAmount: z.string().regex(/^\d+$/),
  usdValue: z.number().nullable(),
  provider: z.string().max(32),
  txHash: hashSchema.optional(),
  recipient: addressSchema.optional(),
});

/**
 * App-side trade records. The browser files them, the chain decides what they are worth: a
 * record with a hash is matched to its receipt — the stock must have arrived in (or left) the
 * wallet it names — and the settled USDC from the receipt replaces the browser's figure. A
 * record whose receipt is not in yet is kept as pending and settled by the verification sweep;
 * a record the receipt contradicts is refused.
 *
 * Only a signed order (CoW) may be filed without a hash: solvers settle it later and the
 * settlement hash arrives through PATCH.
 */
export const POST = route({ rateLimit: { key: "trades.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const repos = getRepos();
  const base: TradeRecord = { ...body, txHash: body.txHash as Hash | undefined, status: "submitted", createdAt: Date.now() };
  if (!body.txHash) {
    if (body.provider !== "cow") throw new AppError("BAD_REQUEST", "A trade record needs its transaction hash; only signed orders are filed before settlement.", 400);
    await repos.trades.create(base);
    return json({ trade: base, verification: "awaiting-settlement" }, { status: 201 });
  }
  const record = await settleTrade(base, body.txHash as Hash);
  await repos.trades.create(record);
  invalidatePortfolioSnapshot(body.owner);
  return json({ trade: record, verification: record.verifiedAt ? "verified" : record.status === "failed" ? "reverted" : "pending" }, { status: 201 });
});

/**
 * What the receipt makes of a record: verified with the chain's own amounts, failed, or still
 * pending (the hash must at least be known to the network — a hash nobody has seen is refused).
 */
export async function settleTrade(record: TradeRecord, txHash: Hash): Promise<TradeRecord> {
  const v = await verifyTrade({ txHash, owner: record.owner, assetAddress: record.assetAddress, side: record.side, recipient: record.recipient });
  if (v.ok) {
    const usdValue = v.usdcAmount !== null ? Math.round(Number(formatUnits(v.usdcAmount, USDC_DECIMALS)) * 100) / 100 : record.usdValue;
    return {
      ...record,
      txHash,
      status: "confirmed",
      usdValue,
      buyAmount: record.side === "buy" ? v.assetAmount.toString() : v.usdcAmount !== null ? v.usdcAmount.toString() : record.buyAmount,
      sellAmount: record.side === "sell" ? v.assetAmount.toString() : v.usdcAmount !== null ? v.usdcAmount.toString() : record.sellAmount,
      verifiedAt: Date.now(),
      verifyNote: undefined,
    };
  }
  if (v.state === "mismatch") {
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  if (v.state === "reverted") return { ...record, txHash, status: "failed", verifyNote: "reverted" };
  const known = await getServerPublicClient()
    .getTransaction({ hash: txHash })
    .then(() => true)
    .catch(() => false);
  if (!known) throw new AppError("TX_PENDING", "That transaction is not known to the network.", 404);
  return { ...record, txHash, status: "submitted" };
}

export const GET = route({ rateLimit: { key: "trades.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  return json({ trades: await getRepos().trades.listByOwner(owner) });
});

import { z } from "zod";
import { formatUnits, type Hash } from "viem";
import { route, json, parseBody, parseQuery, addressSchema, hashSchema } from "@/lib/api";
import { getRepos, type TradeRecord } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { USDC_DECIMALS } from "@/config/chain";
import { TRADE_PROVIDER_IDS } from "@/domain/trade";
import { sessionAddress } from "@/lib/auth/session";
import { boundedUsd } from "@/lib/trade/record-usd";
import { invalidatePortfolioSnapshot } from "@/services/portfolio-service";
import { getAsset } from "@/services/b20-asset-service";
import { estimateStockUsd } from "@/services/price-service";
import { verdictError, verifyTrade } from "@/services/tx-verify-service";
import { getOrder } from "@/providers/trading/cow/adapter";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { feeBpsFor } from "@/lib/fees";

const createSchema = z.object({
  id: z.string().min(8).max(64),
  owner: addressSchema,
  side: z.enum(["buy", "sell"]),
  assetAddress: addressSchema,
  sellAmount: z.string().regex(/^\d+$/),
  buyAmount: z.string().regex(/^\d+$/),
  usdValue: z.number().nullable(),
  provider: z.enum(TRADE_PROVIDER_IDS),
  txHash: hashSchema.optional(),
  recipient: addressSchema.optional(),
  /** A signed order's uid, for a record filed before settlement: the order book names its owner. */
  orderUid: z.string().regex(/^0x[0-9a-fA-F]{112}$/).optional(),
});

/** Postgres 23505, however the client wraps it. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "23505" || /duplicate key value/i.test(err instanceof Error ? err.message : String((err as { message?: unknown } | null)?.message ?? ""));
}

/** Marks a record filed while its receipt was pending by a wallet that was signed in at the time, so the sweep can trust it the same way. */
export const FILED_BY_OWNER = "pending:signed-in";

/**
 * Whether a request may speak for `owner`. A session names the wallet outright; a request without
 * one may still file a record, but only for a transaction the chain shows that wallet sent (see
 * `initiatedBy`). A session for a different wallet is refused whatever the receipt says.
 */
export function sessionFor(req: Request, owner: string): boolean {
  const signedIn = sessionAddress(req);
  if (signedIn && signedIn.toLowerCase() !== owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "This action is only allowed for the signed-in wallet.", 403);
  return !!signedIn;
}

/**
 * App-side trade records. The browser files them, the chain decides what they are worth: a
 * record with a hash is matched to its receipt — the stock must have arrived in (or left) the
 * wallet it names — and the settled USDC from the receipt replaces the browser's figure. A
 * record whose receipt is not in yet is kept as pending and settled by the verification sweep;
 * a record the receipt contradicts is refused.
 *
 * Who may file: the wallet's own session, or nobody in particular as long as the receipt shows
 * that wallet sent the transaction. Anyone used to be able to write anyone else's real trades
 * into their history and the platform's figures; now a stranger's hash is refused unless the
 * wallet signs in, and a USD figure the receipt cannot settle is bounded by what the stock that
 * moved is actually worth.
 *
 * Only a signed order (CoW) may be filed without a hash: solvers settle it later and the
 * settlement hash arrives through PATCH.
 */
export const POST = route({ rateLimit: { key: "trades.write", limit: 60, windowMs: 60_000, durable: true } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const trusted = sessionFor(req, body.owner);
  const repos = getRepos();
  const feeBps = feeBpsFor(body.provider);
  const { orderUid, ...fields } = body;
  const base: TradeRecord = { ...fields, txHash: body.txHash as Hash | undefined, status: "submitted", createdAt: Date.now(), ...(feeBps > 0 ? { feeBps } : {}) };
  if (!body.txHash) {
    if (body.provider !== "cow") throw new AppError("BAD_REQUEST", "A trade record needs its transaction hash; only signed orders are filed before settlement.", 400);
    if (!trusted) {
      // No session and nothing mined: the order book is the witness. It names the wallet that signed the order.
      if (!orderUid) throw new AppError("UNAUTHORIZED", "Sign in with this wallet, or name the order, to file it before it settles.", 401);
      const order = await getOrder(orderUid).catch(() => null);
      if (!order || !order.owner || order.owner.toLowerCase() !== body.owner.toLowerCase()) throw new AppError("UNAUTHORIZED", "That order was not signed by this wallet.", 401);
      if (order.assetAddress && order.assetAddress.toLowerCase() !== body.assetAddress.toLowerCase()) throw new AppError("TX_MISMATCH", "That order trades a different stock.", 400);
    }
    await repos.trades.create({ ...base, orderUid, verifyNote: FILED_BY_OWNER });
    return json({ trade: base, verification: "awaiting-settlement" }, { status: 201 });
  }
  const record = await settleTrade(base, body.txHash as Hash, { trusted });
  try {
    await repos.trades.create(record);
  } catch (err) {
    // The table keeps one row per (transaction, stock, side, wallet): a retried request is the same trade, already filed.
    if (isUniqueViolation(err)) return json({ trade: record, verification: "duplicate" }, { status: 200 });
    throw err;
  }
  invalidatePortfolioSnapshot(body.owner);
  return json({ trade: record, verification: record.verifiedAt ? "verified" : record.status === "failed" ? "reverted" : "pending" }, { status: 201 });
});

/**
 * What the receipt makes of a record: verified with the chain's own amounts, failed, or still
 * pending (the hash must at least be known to the network — a hash nobody has seen is refused).
 *
 * `trusted` says the caller has already proven the wallet (a session, or a record the sweep is
 * finishing that was filed under one). Without it, the receipt has to show the wallet sent the
 * transaction before the record is kept.
 */
export async function settleTrade(record: TradeRecord, txHash: Hash, opts: { trusted?: boolean } = {}): Promise<TradeRecord> {
  const v = await verifyTrade({ txHash, owner: record.owner, assetAddress: record.assetAddress, side: record.side, recipient: record.recipient });
  if (v.ok) {
    if (!opts.trusted && !v.initiatedByOwner) throw new AppError("UNAUTHORIZED", "That transaction was not sent by this wallet. Sign in with the wallet to file it.", 401);
    let usdValue = record.usdValue;
    if (v.usdcAmount !== null) usdValue = Math.round(Number(formatUnits(v.usdcAmount, USDC_DECIMALS)) * 100) / 100;
    else {
      // No USDC leg to read (paid in ETH, or one of several stocks bought in one transaction):
      // the browser's figure stays only while the stock that moved is worth about that much.
      const asset = await getAsset(record.assetAddress).catch(() => null);
      const estimate = asset ? await estimateStockUsd(asset, v.assetAmount).catch(() => null) : null;
      usdValue = boundedUsd(record.usdValue, estimate);
    }
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
  // Pending: the sweep finishes the check; it needs to know whether the wallet had already proven itself.
  return { ...record, txHash, status: "submitted", verifyNote: opts.trusted ? FILED_BY_OWNER : record.verifyNote === FILED_BY_OWNER ? FILED_BY_OWNER : undefined };
}

export const GET = route({ rateLimit: { key: "trades.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  return json({ trades: await getRepos().trades.listByOwner(owner) });
});

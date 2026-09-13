import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { FILED_BY_OWNER, sessionFor, settleTrade } from "../route";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["submitted", "confirmed", "failed"]).optional(),
});

/**
 * How a trade ended, as the chain tells it. The browser reports a settlement hash (a signed
 * order that solvers filled) or a final status; either way the receipt decides: a hash is matched
 * to the record before it is kept, "confirmed" is only ever set from a receipt, and "failed" is
 * kept when the receipt agrees or there is no receipt to disagree.
 *
 * A session, when there is one, has to be the record's own wallet. Without one the chain is the
 * only witness, so a report of failure with nothing to check is accepted only for the one shape
 * that has no hash to check: a signed order that expired or was cancelled before it settled.
 */
export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "trades.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const repos = getRepos();
  const current = await repos.trades.get(id);
  if (!current) throw new AppError("NOT_FOUND", "Trade record not found", 404);
  // The session's trust, or the trust a still-pending record was filed under; a verified record needs the session itself.
  const trusted = sessionFor(req, current.owner) || (!current.verifiedAt && current.verifyNote === FILED_BY_OWNER);

  const hash = (body.txHash ?? current.txHash) as Hash | undefined;
  if (body.txHash || body.status === "confirmed") {
    if (!hash) throw new AppError("BAD_REQUEST", "A confirmation needs a transaction hash.", 400);
    if (current.verifiedAt && current.txHash?.toLowerCase() === hash.toLowerCase()) return json({ trade: current });
    // A verified record is what the chain says it is; only its own wallet may point it at another transaction.
    if (current.verifiedAt && !trusted) throw new AppError("UNAUTHORIZED", "Sign in with this wallet to change a verified record.", 401);
    const settled = await settleTrade(current, hash, { trusted });
    const updated = await repos.trades.update(id, { txHash: settled.txHash, status: settled.status, usdValue: settled.usdValue, buyAmount: settled.buyAmount, sellAmount: settled.sellAmount, verifiedAt: settled.verifiedAt, verifyNote: settled.verifyNote });
    return json({ trade: updated ?? settled });
  }
  if (body.status === "failed") {
    // A verified record is what the chain says it is; a report of failure cannot unsay it.
    if (current.verifiedAt) return json({ trade: current });
    if (hash) {
      const settled = await settleTrade(current, hash, { trusted }).catch(() => null);
      if (settled?.verifiedAt) {
        const updated = await repos.trades.update(id, { status: "confirmed", usdValue: settled.usdValue, buyAmount: settled.buyAmount, sellAmount: settled.sellAmount, verifiedAt: settled.verifiedAt });
        return json({ trade: updated ?? settled });
      }
    }
    if (!trusted && !(!current.txHash && current.provider === "cow")) throw new AppError("UNAUTHORIZED", "Sign in with this wallet to report this trade as failed.", 401);
    const updated = await repos.trades.update(id, { status: "failed" });
    return json({ trade: updated ?? current });
  }
  return json({ trade: current });
});

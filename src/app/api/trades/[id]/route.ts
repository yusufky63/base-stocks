import { z } from "zod";
import type { Hash } from "viem";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { settleTrade } from "../route";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["submitted", "confirmed", "failed"]).optional(),
});

/**
 * How a trade ended, as the chain tells it. The browser reports a settlement hash (a signed
 * order that solvers filled) or a final status; either way the receipt decides: a hash is matched
 * to the record before it is kept, "confirmed" is only ever set from a receipt, and "failed" is
 * kept when the receipt agrees or there is no receipt to disagree.
 */
export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "trades.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const repos = getRepos();
  const current = await repos.trades.get(id);
  if (!current) throw new AppError("NOT_FOUND", "Trade record not found", 404);

  const hash = (body.txHash ?? current.txHash) as Hash | undefined;
  if (body.txHash || body.status === "confirmed") {
    if (!hash) throw new AppError("BAD_REQUEST", "A confirmation needs a transaction hash.", 400);
    if (current.verifiedAt && current.txHash?.toLowerCase() === hash.toLowerCase()) return json({ trade: current });
    const settled = await settleTrade(current, hash);
    const updated = await repos.trades.update(id, { txHash: settled.txHash, status: settled.status, usdValue: settled.usdValue, buyAmount: settled.buyAmount, sellAmount: settled.sellAmount, verifiedAt: settled.verifiedAt, verifyNote: settled.verifyNote });
    return json({ trade: updated ?? settled });
  }
  if (body.status === "failed") {
    // A verified record is what the chain says it is; a report of failure cannot unsay it.
    if (current.verifiedAt) return json({ trade: current });
    if (hash) {
      const settled = await settleTrade(current, hash).catch(() => null);
      if (settled?.verifiedAt) {
        const updated = await repos.trades.update(id, { status: "confirmed", usdValue: settled.usdValue, buyAmount: settled.buyAmount, sellAmount: settled.sellAmount, verifiedAt: settled.verifiedAt });
        return json({ trade: updated ?? settled });
      }
    }
    const updated = await repos.trades.update(id, { status: "failed" });
    return json({ trade: updated ?? current });
  }
  return json({ trade: current });
});

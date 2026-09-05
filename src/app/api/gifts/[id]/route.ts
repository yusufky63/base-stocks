import { z } from "zod";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { getGiftReceipt } from "@/services/gift-service";
import { verdictError, verifyGift, verifyGiftClaim, verifyGiftReclaim } from "@/services/tx-verify-service";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";
import type { GiftRecord } from "@/domain/gift";

const patchSchema = z.object({
  txHash: hashSchema.optional(),
  status: z.enum(["draft", "submitted", "confirmed", "failed", "claimed", "reclaimed"]).optional(),
  /** Claim-link: the claim (or reclaim) transaction. Who received is read from the escrow's log, never from the body. */
  claimTx: hashSchema.optional(),
});

/** Public receipt (sender, recipient, amount, message, tx) for a gift that was submitted onchain. */
export const GET = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "gifts.read", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const { id } = await params;
  const receipt = await getGiftReceipt(id);
  if (!receipt) throw new AppError("NOT_FOUND", "Gift not found", 404);
  return json({ receipt }, { cacheSeconds: 30, staleSeconds: 300 });
});

/**
 * What became of a gift, as the chain tells it. A funding or sending hash is matched to the
 * record before it is kept (the stock moved from this sender to this recipient, or the escrow
 * emitted `GiftCreated` for this id); a claim is matched to `GiftClaimed`, which also says who
 * received. A hash whose receipt is not in yet is kept and settled by the verification sweep.
 */
export const PATCH = route<{ params: Promise<{ id: string }> }>({ rateLimit: { key: "gifts.write", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const { id } = await params;
  const body = await parseBody(req, patchSchema);
  const repos = getRepos();
  const current = await repos.gifts.get(id);
  if (!current) throw new AppError("NOT_FOUND", "Gift not found", 404);

  // The claim or the refund of a claim-link gift.
  if (body.claimTx && (body.status === "claimed" || body.status === "reclaimed")) {
    if (current.kind !== "claim-link") throw new AppError("BAD_REQUEST", "Only claim-link gifts are claimed.", 400);
    const patch = await settleGiftClaim(current, body.claimTx as Hash, body.status);
    const updated = await repos.gifts.update(id, patch);
    return json({ gift: updated ?? { ...current, ...patch } });
  }

  // The transaction that funds or sends the gift.
  const hash = (body.txHash ?? current.txHash) as Hash | undefined;
  if (body.txHash || body.status === "submitted" || body.status === "confirmed" || body.status === "failed") {
    if (!hash) throw new AppError("BAD_REQUEST", "A gift status needs its transaction hash.", 400);
    if (current.verifiedAt && current.txHash?.toLowerCase() === hash.toLowerCase() && body.status !== "failed") return json({ gift: current });
    const patch = await settleGiftFunding(current, hash, body.status);
    const updated = await repos.gifts.update(id, patch);
    return json({ gift: updated ?? { ...current, ...patch } });
  }
  return json({ gift: current });
});

/** Match a funding/sending hash to the record; the amount the chain shows replaces the draft's. */
export async function settleGiftFunding(gift: GiftRecord, txHash: Hash, requested?: GiftRecord["status"]): Promise<Partial<GiftRecord>> {
  const v = await verifyGift(gift, txHash);
  if (v.ok) {
    // A direct send is done once it is mined; a claim link stays "submitted" until it is claimed or taken back.
    const status: GiftRecord["status"] = gift.kind === "claim-link" ? (gift.status === "claimed" || gift.status === "reclaimed" ? gift.status : "submitted") : "confirmed";
    return { txHash, status, rawAmount: v.amount.toString(), verifiedAt: Date.now(), verifyNote: undefined };
  }
  if (v.state === "mismatch") {
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  if (v.state === "reverted") return { txHash, status: "failed", verifyNote: "reverted" };
  // Not mined yet: keep the hash, keep the record unproven, and let the sweep finish the job.
  return { txHash, status: requested === "failed" ? "failed" : gift.status === "draft" ? "submitted" : gift.status };
}

/** Match a claim or reclaim hash to the escrow's own log; the recipient comes from the log. */
export async function settleGiftClaim(gift: GiftRecord, claimTx: Hash, kind: "claimed" | "reclaimed"): Promise<Partial<GiftRecord>> {
  if (kind === "claimed") {
    const v = await verifyGiftClaim(gift, claimTx);
    if (v.ok) return { status: "claimed", claimTx, recipient: v.recipient, verifiedAt: Date.now(), verifyNote: undefined };
    return pendingOrThrow(v, claimTx, kind);
  }
  const v = await verifyGiftReclaim(gift, claimTx);
  if (v.ok) return { status: "reclaimed", claimTx, verifiedAt: Date.now(), verifyNote: undefined };
  return pendingOrThrow(v, claimTx, kind);
}

function pendingOrThrow(v: { ok: false; state: "pending" | "reverted" | "mismatch"; reason: string }, claimTx: Hash, kind: "claimed" | "reclaimed"): Partial<GiftRecord> {
  if (v.state === "mismatch") {
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  if (v.state === "reverted") throw new AppError("TX_REVERTED", v.reason, 409);
  // Not mined yet: remember the hash and what it is for; the sweep verifies it.
  return { claimTx, verifyNote: `pending:${kind}` };
}

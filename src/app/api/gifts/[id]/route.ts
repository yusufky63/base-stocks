import { z } from "zod";
import { route, json, parseBody, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { claimPatch, fundingPatch, getGiftReceipt } from "@/services/gift-service";
import { verifyGift, verifyGiftClaim, verifyGiftReclaim } from "@/services/tx-verify-service";
import { AppError } from "@/lib/errors";
import { sessionAddress } from "@/lib/auth/session";
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
  // The sender's session, when there is one. Gift ids sit in every receipt URL, so a record the
  // chain has already proven may only be pointed at another transaction by the wallet that sent it.
  const signedIn = sessionAddress(req);
  if (signedIn && signedIn.toLowerCase() !== current.sender.toLowerCase() && signedIn.toLowerCase() !== current.recipient.toLowerCase()) throw new AppError("UNAUTHORIZED", "This action is only allowed for the signed-in wallet.", 403);
  const isSender = !!signedIn && signedIn.toLowerCase() === current.sender.toLowerCase();
  const claimSettled = (current.status === "claimed" || current.status === "reclaimed") && !!current.verifiedAt && !current.verifyNote?.startsWith("pending:");

  // The claim or the refund of a claim-link gift.
  if (body.claimTx && (body.status === "claimed" || body.status === "reclaimed")) {
    if (current.kind !== "claim-link") throw new AppError("BAD_REQUEST", "Only claim-link gifts are claimed.", 400);
    if (claimSettled) return json({ gift: current });
    const patch = await settleGiftClaim(current, body.claimTx as Hash, body.status);
    const updated = await repos.gifts.update(id, patch);
    return json({ gift: updated ?? { ...current, ...patch } });
  }

  // The transaction that funds or sends the gift.
  const hash = (body.txHash ?? current.txHash) as Hash | undefined;
  if (body.txHash || body.status === "submitted" || body.status === "confirmed" || body.status === "failed") {
    if (!hash) throw new AppError("BAD_REQUEST", "A gift status needs its transaction hash.", 400);
    const sameHash = current.txHash?.toLowerCase() === hash.toLowerCase();
    if (current.verifiedAt && sameHash && body.status !== "failed") return json({ gift: current });
    if (current.verifiedAt && !sameHash && !isSender) throw new AppError("UNAUTHORIZED", "This gift is already matched to its transaction. Sign in with the sending wallet to change it.", 401);
    const patch = await settleGiftFunding(current, hash, body.status);
    // A receipt that is not in yet must not unseat one that is.
    if (current.verifiedAt && !patch.verifiedAt) return json({ gift: current });
    const updated = await repos.gifts.update(id, patch);
    return json({ gift: updated ?? { ...current, ...patch } });
  }
  return json({ gift: current });
});

/**
 * Match a funding/sending hash to the record; the amount (and, for a claim link, the expiry) the
 * chain shows replace the draft's. The transition table lives in `fundingPatch`; this is the
 * signature the sweep and the create route import.
 */
export async function settleGiftFunding(gift: GiftRecord, txHash: Hash, requested?: GiftRecord["status"]): Promise<Partial<GiftRecord>> {
  return fundingPatch(gift, txHash, await verifyGift(gift, txHash), requested);
}

/** Match a claim or reclaim hash to the escrow's own log; the recipient comes from the log. */
export async function settleGiftClaim(gift: GiftRecord, claimTx: Hash, kind: "claimed" | "reclaimed"): Promise<Partial<GiftRecord>> {
  return claimPatch(claimTx, kind, kind === "claimed" ? await verifyGiftClaim(gift, claimTx) : await verifyGiftReclaim(gift, claimTx));
}

import type { Address, Hash } from "viem";
import { getRepos } from "@/db/repositories";
import { getAssets } from "@/services/b20-asset-service";
import { getBasenameAvatar, reverseResolve } from "@/services/basename-service";
import { toAssetDTO } from "@/domain/asset";
import type { GiftParty, GiftReceipt, GiftRecord } from "@/domain/gift";
import { isBrandLikeName } from "@/lib/gift/format";
import { findRecentLog } from "@/lib/gift/logs";
import { escrowAddressOf, giftEscrowAbi } from "@/lib/escrow";
import { getLogPublicClient, getServerPublicClient } from "@/lib/viem/server-client";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { verdictError, verifyGift, type GiftFacts, type Verdict } from "./tx-verify-service";

export type { GiftParty, GiftReceipt } from "@/domain/gift";
// Display helpers live in lib/gift/format so client bundles do not import this module; the
// server-side callers that used to find them here still can.
export { giftAmountLabel, giftPartyLabel, giftPartyName } from "@/lib/gift/format";

const ZERO = "0x0000000000000000000000000000000000000000";
const GIFT_CREATED = giftEscrowAbi.find((x) => x.type === "event" && x.name === "GiftCreated")!;

/**
 * A stuck draft is looked for on the chain between these ages: young enough that the funding was
 * minutes ago, old enough that the browser's own write has clearly not arrived. Past the window
 * the draft is left alone rather than costing a read per sweep forever.
 */
const REPAIR_MIN_AGE_MS = 5 * 60_000;
const REPAIR_MAX_AGE_MS = 24 * 3600_000;

/**
 * The repos write a column only when the field is not `undefined`, so `undefined` cannot clear a
 * stored note or hash. `null` goes through as SQL null; the type is widened here, once, with the
 * reason, instead of at every call site.
 */
const CLEAR = null as unknown as undefined;

export async function party(address: Address, knownBasename?: string): Promise<GiftParty> {
  const repos = getRepos();
  const [basename, profile] = await Promise.all([knownBasename ? Promise.resolve(knownBasename) : reverseResolve(address).catch(() => null), repos.profiles.get(address).catch(() => null)]);
  const avatar = basename ? await getBasenameAvatar(basename).catch(() => null) : null;
  const pub = profile?.isPublic ?? false;
  // A display name that reads like the brand or its support desk is dropped outright: shown next to
  // an address it would still do the phisher's work.
  const displayName = pub && profile?.displayName && !isBrandLikeName(profile.displayName) ? profile.displayName : null;
  return { address, basename: basename ?? null, handle: pub ? (profile?.handle ?? null) : null, displayName, avatar, isMember: !!profile };
}

export async function getGiftReceipt(id: string): Promise<GiftReceipt | null> {
  if (!/^gift_[a-z0-9_]{4,60}$/i.test(id)) return null;
  let gift = await getRepos().gifts.get(id);
  if (!gift) return null;
  // A draft whose escrow the chain already holds is a record the browser never finished writing;
  // the receipt page is where its recipient is standing, so it is repaired on the spot.
  if (gift.status === "draft" && gift.escrowId) gift = (await repairDraftGift(gift).catch(() => null)) ?? gift;
  if (gift.status === "draft" || !gift.txHash) return null;
  const assets = await getAssets();
  const asset = assets.find((a) => a.address.toLowerCase() === gift.assetAddress.toLowerCase()) ?? null;
  const zero = gift.recipient === ZERO;
  const [sender, recipient] = await Promise.all([party(gift.sender), zero ? Promise.resolve({ address: gift.recipient, basename: null, handle: null, displayName: null, avatar: null, isMember: false } satisfies GiftParty) : party(gift.recipient, gift.recipientBasename)]);
  return { gift, asset: asset ? toAssetDTO(asset) : null, sender, recipient };
}

/* ------------------------------ state transitions ------------------------------ */

/**
 * The patch a funding verdict earns. Proven: the chain's amount (and, for a claim link, the
 * escrow's expiry) replace the draft's, and the record is marked verified. Pending: the hash is
 * kept and the sweep finishes the job. Reverted: failed. A mismatch is refused to the caller.
 */
export function fundingPatch(gift: GiftRecord, txHash: Hash, v: Verdict<GiftFacts>, requested?: GiftRecord["status"]): Partial<GiftRecord> {
  if (v.ok) {
    // A direct send is done once it is mined; a claim link stays "submitted" until it is claimed or taken back.
    const status: GiftRecord["status"] = gift.kind === "claim-link" ? (gift.status === "claimed" || gift.status === "reclaimed" ? gift.status : "submitted") : "confirmed";
    return { txHash, status, rawAmount: v.amount.toString(), ...(v.expiresAt !== undefined ? { expiresAt: v.expiresAt } : {}), verifiedAt: Date.now(), verifyNote: CLEAR };
  }
  if (v.state === "mismatch") {
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  if (v.state === "reverted") return { txHash, status: "failed", verifyNote: "reverted" };
  // Not mined yet: keep the hash, keep the record unproven, and let the sweep finish the job.
  return { txHash, status: requested === "failed" ? "failed" : gift.status === "draft" ? "submitted" : gift.status };
}

/** The patch a claim or reclaim verdict earns; the recipient comes from the escrow's own log. */
export function claimPatch(claimTx: Hash, kind: "claimed" | "reclaimed", v: Verdict<{ recipient?: Address }>): Partial<GiftRecord> {
  if (v.ok) return { status: kind, claimTx, ...(kind === "claimed" && v.recipient ? { recipient: v.recipient } : {}), verifiedAt: Date.now(), verifyNote: CLEAR };
  if (v.state === "mismatch") {
    const e = verdictError(v);
    throw new AppError(e.code, e.message, e.status);
  }
  if (v.state === "reverted") throw new AppError("TX_REVERTED", v.reason, 409);
  // Not mined yet: remember the hash and what it is for; the sweep verifies it.
  return { claimTx, verifyNote: `pending:${kind}` };
}

/**
 * What the sweep writes when a reported claim hash turns out to be wrong: the funding record stands
 * (the escrow still holds the stock), the claim report is dropped, and the reason is kept.
 */
export function rejectedClaimPatch(kind: "claimed" | "reclaimed", reason: string): Partial<GiftRecord> {
  return { claimTx: CLEAR, verifyNote: `claim ${kind} rejected: ${reason}`.slice(0, 200) };
}

/* --------------------------------- repair --------------------------------- */

/**
 * A claim-link draft the chain shows as funded: finds its `GiftCreated` by the indexed escrow id,
 * verifies it like any reported hash and writes the result. Returns the updated record, or null
 * when the escrow is empty (never funded, or already claimed and gone) or nothing could be found.
 */
export async function repairDraftGift(gift: GiftRecord): Promise<GiftRecord | null> {
  if (gift.status !== "draft" || !gift.escrowId) return null;
  // The record's own escrow, not the current one: a draft from before the redeployment was funded
  // into the old contract and that is where its `GiftCreated` is.
  const escrow = escrowAddressOf(gift);
  const client = getServerPublicClient();
  const [sender] = await client.readContract({ address: escrow, abi: giftEscrowAbi, functionName: "gifts", args: [gift.escrowId] });
  if (sender === ZERO) return null;
  const log = await findRecentLog(getLogPublicClient(), { address: escrow, event: GIFT_CREATED, args: { id: gift.escrowId } });
  if (!log?.transactionHash) return null;
  const patch = fundingPatch(gift, log.transactionHash, await verifyGift(gift, log.transactionHash));
  const updated = await getRepos().gifts.update(gift.id, patch);
  metrics.count("gift.repair", true, gift.id);
  return updated ?? { ...gift, ...patch };
}

/** Sweep step: every claim-link draft old enough to be stuck and young enough to be worth a read. */
export async function repairDraftGifts(limit = 300): Promise<{ checked: number; repaired: number }> {
  const now = Date.now();
  const drafts = (await getRepos().gifts.listAll(limit).catch(() => [])).filter((g) => g.status === "draft" && !!g.escrowId && now - g.createdAt >= REPAIR_MIN_AGE_MS && now - g.createdAt <= REPAIR_MAX_AGE_MS);
  let repaired = 0;
  for (const g of drafts) {
    try {
      if (await repairDraftGift(g)) repaired += 1;
    } catch (err) {
      metrics.count("gift.repair", false, err instanceof Error ? err.message : String(err));
    }
  }
  return { checked: drafts.length, repaired };
}

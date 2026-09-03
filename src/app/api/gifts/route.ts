import { z } from "zod";
import { keccak256, stringToHex, type Hash } from "viem";
import { route, json, parseBody, parseQuery, addressSchema, hashSchema } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { b20Guard } from "@/services/b20-guard-service";
import { resolveRecipient } from "@/services/basename-service";
import { AppError } from "@/lib/errors";
import type { GiftRecord } from "@/domain/gift";

const createSchema = z.object({
  kind: z.enum(["send-existing", "buy-for-recipient"]),
  sender: addressSchema,
  /** Raw address or Basename; resolved server-side and echoed back for the review screen. */
  recipient: z.string().min(1).max(255),
  assetAddress: addressSchema,
  rawAmount: z.string().regex(/^\d+$/),
  message: z.string().max(280).optional(),
  txHash: hashSchema.optional(),
});

/** Compact bytes32 reconciliation memo derived from the gift id (never a human message). */
export function giftMemo(id: string): `0x${string}` {
  return keccak256(stringToHex(`bstocks:gift:${id}`));
}

/**
 * Create a gift record. Runs the B20 guard (canonical, transfer state, sender+recipient policy)
 * and resolves the recipient so the client can show the exact address in review.
 */
export const POST = route({ rateLimit: { key: "gifts.write", limit: 30, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, createSchema);
  const resolved = await resolveRecipient(body.recipient);
  if (!resolved) throw new AppError("BAD_REQUEST", "Recipient could not be resolved. Enter a Basename like alice.base.eth or a 0x address.", 400);
  if (resolved.address.toLowerCase() === body.sender.toLowerCase()) throw new AppError("BAD_REQUEST", "Recipient must be different from the sender.", 400);
  const { warnings } = await b20Guard.preSendCheck({ assetAddress: body.assetAddress, sender: body.sender, recipient: resolved.address });
  const id = `gift_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const record: GiftRecord = {
    id,
    kind: body.kind,
    sender: body.sender,
    recipient: resolved.address,
    recipientBasename: resolved.basename,
    assetAddress: body.assetAddress,
    rawAmount: body.rawAmount,
    message: body.message,
    memo: giftMemo(id),
    txHash: body.txHash as Hash | undefined,
    status: body.txHash ? "submitted" : "draft",
    createdAt: Date.now(),
  };
  await getRepos().gifts.create(record);
  return json({ gift: record, warnings }, { status: 201 });
});

export const GET = route({ rateLimit: { key: "gifts.read", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { owner } = parseQuery(req, z.object({ owner: addressSchema }));
  return json({ gifts: await getRepos().gifts.listByOwner(owner) });
});

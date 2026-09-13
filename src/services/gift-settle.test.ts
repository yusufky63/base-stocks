import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import type { GiftRecord } from "@/domain/gift";

/**
 * The state table behind `settleGiftFunding` / `settleGiftClaim`: what the record becomes for each
 * verdict the chain can give. The verifiers are mocked; nothing here touches a network.
 */
const verifyGift = vi.fn();
const verifyGiftClaim = vi.fn();
const verifyGiftReclaim = vi.fn();

vi.mock("@/services/tx-verify-service", () => ({
  verifyGift: (...a: unknown[]) => verifyGift(...a),
  verifyGiftClaim: (...a: unknown[]) => verifyGiftClaim(...a),
  verifyGiftReclaim: (...a: unknown[]) => verifyGiftReclaim(...a),
  verdictError: (v: { state: string; reason: string }) => (v.state === "pending" ? { code: "TX_PENDING", status: 409, message: v.reason } : v.state === "reverted" ? { code: "TX_REVERTED", status: 409, message: v.reason } : { code: "TX_MISMATCH", status: 400, message: v.reason }),
}));
vi.mock("@/db/repositories", () => ({ getRepos: () => ({}) }));
vi.mock("@/services/b20-asset-service", () => ({ getAssets: async () => [] }));
vi.mock("@/services/basename-service", () => ({ reverseResolve: async () => null, getBasenameAvatar: async () => null }));
vi.mock("@/lib/viem/server-client", () => ({ getServerPublicClient: () => ({}), getLogPublicClient: () => ({}) }));
vi.mock("@/lib/http", () => ({ metrics: { count: vi.fn() } }));
vi.mock("@/lib/api", () => ({
  route: (_o: unknown, h: unknown) => h,
  json: (d: unknown) => d,
  parseBody: async () => ({}),
  hashSchema: { optional: () => ({}) },
}));
vi.mock("zod", () => ({ z: { object: () => ({}), enum: () => ({ optional: () => ({}) }) } }));
vi.mock("@/lib/auth/session", () => ({ sessionAddress: () => null }));

import { settleGiftClaim, settleGiftFunding } from "@/app/api/gifts/[id]/route";
import { rejectedClaimPatch } from "./gift-service";

const SENDER = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const RECIPIENT = "0x000000000000000000000000000000000000bEEF" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const TX = `0x${"1".repeat(64)}` as Hash;
const CLAIM_TX = `0x${"2".repeat(64)}` as Hash;

const gift = (over: Partial<GiftRecord> = {}): GiftRecord => ({
  id: "gift_t1",
  kind: "claim-link",
  sender: SENDER,
  recipient: ZERO,
  assetAddress: "0xb20000000000000000000078ee7ce2fE4908108C",
  rawAmount: "1",
  memo: "0x00" as Hex,
  status: "draft",
  createdAt: 0,
  escrowId: `0x${"e".repeat(64)}` as Hex,
  expiresAt: 5,
  ...over,
});

describe("settleGiftFunding", () => {
  it("a proven claim link becomes submitted, with the chain's amount and the escrow's expiry", async () => {
    verifyGift.mockResolvedValueOnce({ ok: true, blockNumber: 1, amount: 123n, expiresAt: 9_000_000 });
    const p = await settleGiftFunding(gift(), TX);
    expect(p).toMatchObject({ txHash: TX, status: "submitted", rawAmount: "123", expiresAt: 9_000_000 });
    expect(p.verifiedAt).toBeTypeOf("number");
    expect(p.verifyNote).toBeNull(); // cleared, not left undefined (the repo skips undefined)
  });
  it("a proven direct send is confirmed; a link already claimed keeps its state", async () => {
    verifyGift.mockResolvedValueOnce({ ok: true, blockNumber: 1, amount: 5n });
    expect((await settleGiftFunding(gift({ kind: "send-existing", recipient: RECIPIENT }), TX)).status).toBe("confirmed");
    verifyGift.mockResolvedValueOnce({ ok: true, blockNumber: 1, amount: 5n });
    expect((await settleGiftFunding(gift({ status: "claimed" }), TX)).status).toBe("claimed");
  });
  it("a pending receipt keeps the hash and moves a draft to submitted without proving it", async () => {
    verifyGift.mockResolvedValueOnce({ ok: false, state: "pending", reason: "not yet" });
    expect(await settleGiftFunding(gift(), TX)).toEqual({ txHash: TX, status: "submitted" });
    verifyGift.mockResolvedValueOnce({ ok: false, state: "pending", reason: "not yet" });
    expect(await settleGiftFunding(gift({ status: "submitted" }), TX, "failed")).toEqual({ txHash: TX, status: "failed" });
  });
  it("a revert fails the record; a mismatch is refused to the caller", async () => {
    verifyGift.mockResolvedValueOnce({ ok: false, state: "reverted", reason: "reverted" });
    expect(await settleGiftFunding(gift(), TX)).toMatchObject({ status: "failed", verifyNote: "reverted" });
    verifyGift.mockResolvedValueOnce({ ok: false, state: "mismatch", reason: "different sender" });
    await expect(settleGiftFunding(gift(), TX)).rejects.toThrow(/different sender/);
  });
});

describe("settleGiftClaim", () => {
  it("a proven claim names the recipient from the log, never from the caller", async () => {
    verifyGiftClaim.mockResolvedValueOnce({ ok: true, blockNumber: 2, recipient: RECIPIENT, amount: 1n });
    const p = await settleGiftClaim(gift({ status: "submitted" }), CLAIM_TX, "claimed");
    expect(p).toMatchObject({ status: "claimed", claimTx: CLAIM_TX, recipient: RECIPIENT });
    expect(p.verifiedAt).toBeTypeOf("number");
  });
  it("a proven reclaim leaves the recipient alone", async () => {
    verifyGiftReclaim.mockResolvedValueOnce({ ok: true, blockNumber: 2 });
    const p = await settleGiftClaim(gift({ status: "submitted" }), CLAIM_TX, "reclaimed");
    expect(p).toMatchObject({ status: "reclaimed", claimTx: CLAIM_TX });
    expect(p).not.toHaveProperty("recipient");
  });
  it("a pending claim remembers the hash and what it is for, and changes no status", async () => {
    verifyGiftClaim.mockResolvedValueOnce({ ok: false, state: "pending", reason: "" });
    expect(await settleGiftClaim(gift({ status: "submitted" }), CLAIM_TX, "claimed")).toEqual({ claimTx: CLAIM_TX, verifyNote: "pending:claimed" });
  });
  it("a mismatch or a revert is refused", async () => {
    verifyGiftClaim.mockResolvedValueOnce({ ok: false, state: "mismatch", reason: "no GiftClaimed" });
    await expect(settleGiftClaim(gift(), CLAIM_TX, "claimed")).rejects.toThrow(/no GiftClaimed/);
    verifyGiftReclaim.mockResolvedValueOnce({ ok: false, state: "reverted", reason: "reverted" });
    await expect(settleGiftClaim(gift(), CLAIM_TX, "reclaimed")).rejects.toThrow(/reverted/);
  });
  it("the sweep's answer to a bogus claim drops the hash and keeps the gift", () => {
    const p = rejectedClaimPatch("claimed", "No GiftClaimed for this escrow id in that transaction.");
    expect(p.claimTx).toBeNull();
    expect(p.verifyNote).toMatch(/^claim claimed rejected: No GiftClaimed/);
    expect(p).not.toHaveProperty("status");
  });
});

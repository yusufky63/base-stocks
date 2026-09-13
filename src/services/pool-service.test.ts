import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import type { PoolClaim, PoolOnchainState, PoolRecord } from "@/domain/pool";
import { MemoryPoolClaimRepo, MemoryPoolRepo } from "@/db/pool-repos";

/* ------------------------------- test doubles ------------------------------ */

const pools = new MemoryPoolRepo();
const poolClaims = new MemoryPoolClaimRepo();
const getLogs = vi.fn();
const getTransactionReceipt = vi.fn();
const getBlockNumber = vi.fn();
const blockTimes = vi.fn();

vi.mock("@/db/repositories", () => ({ getRepos: () => ({ pools, poolClaims }) }));
vi.mock("@/lib/viem/server-client", () => ({
  getServerPublicClient: () => ({ multicall: vi.fn() }),
  getLogPublicClient: () => ({ getLogs, getTransactionReceipt, getBlockNumber }),
}));
vi.mock("@/services/b20-asset-service", () => ({ getAssets: async () => [] }));
vi.mock("@/services/price-service", () => ({ getPriceViews: async () => new Map() }));
vi.mock("@/services/basename-service", () => ({ reverseResolve: async () => null }));
vi.mock("@/services/receipt-service", () => ({ blockTimes: (...a: unknown[]) => blockTimes(...a) }));
vi.mock("@/services/tx-verify-service", () => ({ verifyPoolCreate: vi.fn() }));
vi.mock("@/lib/http", () => ({ metrics: { count: vi.fn() } }));
vi.mock("@/lib/pool", async (orig) => ({ ...(await orig<typeof import("@/lib/pool")>()), GIFT_POOL_ADDRESS: "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10", isPoolDeployed: () => true }));

import { effectiveStatus, poolFundingPatch, reconcilePool } from "./pool-service";

const CREATOR = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const ALICE = "0x000000000000000000000000000000000000a11c" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const TX = `0x${"1".repeat(64)}` as Hex;
const NOW = Date.now();

const record = (over: Partial<PoolRecord> = {}): PoolRecord => ({
  id: "pool_t1",
  onchainId: `0x${"a".repeat(64)}` as Hex,
  creator: CREATOR,
  gateMode: "open",
  gateAddress: "0x0000000000000000000000000000000000000000",
  slots: 10,
  legs: [{ token: "0xb20000000000000000000078ee7ce2fE4908108C", amountPerClaim: "1000000" }],
  expiry: NOW + 86_400_000,
  lockedUntil: 0,
  visibility: "public",
  verified: false,
  quests: [],
  memo: "0x00" as Hex,
  status: "live",
  createdAt: NOW - 3_600_000,
  txHash: TX,
  ...over,
});

const onchain = (over: Partial<PoolOnchainState> = {}): PoolOnchainState => ({
  exists: true,
  creator: CREATOR,
  gate: "0x0000000000000000000000000000000000000000",
  slots: 10,
  claimed: 0,
  expiry: NOW + 86_400_000,
  lockedUntil: 0,
  cancelled: false,
  remainingSlots: 10,
  legs: [],
  ...over,
});

/* --------------------------------- status --------------------------------- */

describe("effectiveStatus", () => {
  it("keeps drafts and failures whatever the chain says", () => {
    expect(effectiveStatus(record({ status: "draft" }), onchain())).toBe("draft");
    expect(effectiveStatus(record({ status: "failed" }), onchain({ cancelled: true }))).toBe("failed");
  });
  it("lets the chain win: cancelled, then expired, then live", () => {
    expect(effectiveStatus(record(), onchain({ cancelled: true }))).toBe("cancelled");
    expect(effectiveStatus(record(), onchain({ expiry: NOW - 1 }))).toBe("expired");
    expect(effectiveStatus(record({ status: "submitted" }), onchain())).toBe("live");
  });
  it("uses the chain's expiry over the record's once the pool exists", () => {
    expect(effectiveStatus(record({ expiry: NOW - 1 }), onchain({ expiry: NOW + 1_000_000 }))).toBe("live");
  });
  it("falls back to the record when the chain did not answer", () => {
    expect(effectiveStatus(record({ status: "submitted" }), null)).toBe("submitted");
    expect(effectiveStatus(record({ expiry: NOW - 1 }), null)).toBe("expired");
  });
});

/* --------------------------------- funding -------------------------------- */

describe("poolFundingPatch", () => {
  const facts = { ok: true as const, blockNumber: 1, gate: "0x000000000000000000000000000000000000c0de" as Address, slots: 7, expiry: NOW + 5, lockedUntil: NOW + 1, legs: [{ token: ALICE, amountPerClaim: "42" }] };
  it("overwrites the draft's terms with the chain's and derives the gate mode from the gate", () => {
    const p = poolFundingPatch(record({ status: "draft", gateMode: "link" }), TX, facts, "0x000000000000000000000000000000000000c0de");
    expect(p).toMatchObject({ status: "submitted", gateMode: "signer", gateAddress: facts.gate, slots: 7, expiry: NOW + 5, lockedUntil: NOW + 1, legs: facts.legs });
    expect(p.verifiedAt).toBeTypeOf("number");
    expect(poolFundingPatch(record({ status: "draft" }), TX, facts, null).gateMode).toBe("link");
    expect(poolFundingPatch(record({ status: "draft" }), TX, { ...facts, gate: "0x0000000000000000000000000000000000000000" }, null).gateMode).toBe("open");
  });
  it("keeps a pending hash without proving it, fails a revert, refuses a mismatch", () => {
    expect(poolFundingPatch(record({ status: "draft" }), TX, { ok: false, state: "pending", reason: "" }, null)).toEqual({ txHash: TX, status: "submitted" });
    expect(poolFundingPatch(record(), TX, { ok: false, state: "reverted", reason: "" }, null)).toMatchObject({ status: "failed", verifyNote: "reverted" });
    expect(() => poolFundingPatch(record(), TX, { ok: false, state: "mismatch", reason: "other pool" }, null)).toThrow(/other pool/);
  });
});

/* ------------------------------- reconcile -------------------------------- */

describe("reconcilePool", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getTransactionReceipt.mockResolvedValue({ blockNumber: 100n });
    getBlockNumber.mockResolvedValue(1_000n);
    blockTimes.mockResolvedValue(new Map([[120, 1_700_000_000]]));
    await pools.create(record());
  });

  it("writes log-matched rows as reconciled, timed by their block, and leaves the rest alone", async () => {
    // Alice reported her claim (confirmed); Bob has a ticket and a hash the page sent; Carol is unknown to the app.
    await poolClaims.claimOnce({ poolId: "pool_t1", claimant: ALICE, status: "confirmed", questProof: {}, txHash: `0x${"2".repeat(64)}`, createdAt: NOW - 10 } as PoolClaim);
    await poolClaims.claimOnce({ poolId: "pool_t1", claimant: BOB, status: "issued", questProof: { attested: { 0: 1 } }, createdAt: NOW - 20 } as PoolClaim);
    getLogs.mockResolvedValue([
      { args: { recipient: ALICE }, transactionHash: `0x${"2".repeat(64)}`, blockNumber: 120n },
      { args: { recipient: "0x000000000000000000000000000000000000ca01" }, transactionHash: `0x${"3".repeat(64)}`, blockNumber: 120n },
    ]);

    const res = await reconcilePool(record());
    expect(res).toEqual({ found: 2, added: 1 });

    const alice = await poolClaims.get("pool_t1", ALICE);
    expect(alice?.status).toBe("reconciled"); // not downgraded to "confirmed"
    expect(alice?.blockNumber).toBe(120);

    const carol = await poolClaims.get("pool_t1", "0x000000000000000000000000000000000000ca01" as Address);
    expect(carol?.status).toBe("reconciled");
    expect(carol?.createdAt).toBe(1_700_000_000 * 1000); // the block's time, not the sweep's

    const bob = await poolClaims.get("pool_t1", BOB);
    expect(bob?.status).toBe("issued"); // no log names him; his ticket stays a ticket
    expect(await poolClaims.countByPool("pool_t1")).toBe(2); // tickets are not claims
  });

  it("stamps the pool so the sweep visits the oldest first", async () => {
    getLogs.mockResolvedValue([]);
    await reconcilePool(record());
    expect((await pools.get("pool_t1"))?.lastReconciledAt).toBeTypeOf("number");
  });

  it("scans the contract the pool lives in: the stored one, else the first deployment", async () => {
    getLogs.mockResolvedValue([]);
    // A record from before the column: a pool in the original GiftPool.
    await reconcilePool(record());
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ address: "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10" }));
    // A record stamped with a redeployment: its claims are logged there, not in the old contract.
    const NEW_POOL = "0x000000000000000000000000000000000000EeEe" as Address;
    await reconcilePool(record({ contractAddress: NEW_POOL }));
    expect(getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ address: NEW_POOL }));
  });

  it("never throws: an RPC failure is a zero result", async () => {
    getLogs.mockRejectedValue(new Error("rpc down"));
    expect(await reconcilePool(record())).toEqual({ found: 0, added: 0 });
  });
});

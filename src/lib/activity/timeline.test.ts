import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import type { GiftRecord } from "@/domain/gift";
import type { PoolClaim, PoolRecord } from "@/domain/pool";
import type { PortfolioExecution } from "@/domain/portfolio";
import type { TradeRecord } from "@/db/repositories";
import type { ReceiptState } from "@/services/receipt-service";
import { buildTimeline, type TimelineInput } from "./timeline";

const ME = "0xeaa823ab4c4ee00283d8ed7be713ddf8a5ba0fac" as Address;
const OTHER = "0xbfa6a45dd534d39df47a3f3d2f2b6e88416f9831" as Address;
const AAPL = "0xb200000000000000000000c2e324d24d7eecd1fb" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c" as Address;
const GOOGL = "0xb2000000000000000000002d0ba3164cc74f58b7" as Address;

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;
const ok = (block: number, time?: number): ReceiptState => ({ status: "success", blockNumber: block, blockTime: time });

const assets = [
  { canonicalId: AAPL, address: AAPL, symbol: "AAPLc", decimals: 8 },
  { canonicalId: NVDA, address: NVDA, symbol: "NVDAc", decimals: 8 },
  { canonicalId: GOOGL, address: GOOGL, symbol: "GOOGLc", decimals: 8 },
];

/** Records here are ones the server has already matched to the chain (`verifiedAt`), as every kept record is. */
function trade(over: Partial<TradeRecord> & { id: string; txHash: Hash; assetAddress: Address }): TradeRecord {
  return { owner: ME, side: "buy", sellAmount: "1800000", buyAmount: "500000", usdValue: 1.8, provider: "kyber", status: "submitted", createdAt: 1_000_000, verifiedAt: 1_000_000, ...over };
}

function input(over: Partial<TimelineInput>): TimelineInput {
  return { owner: ME, assets, trades: [], gifts: [], executions: [], earnActions: [], pools: [], poolClaims: [], transfers: [], receipts: new Map(), ...over };
}

describe("one transaction, one row", () => {
  /**
   * The bug this fixes: a four-stock basket showed up five times — once as "Built portfolio $7.20"
   * and once per leg as "Bought … $1.80" — because the executor writes both an execution and a
   * trade record per leg. That read as $14.40 of buying for a $7.20 basket.
   */
  it("folds a basket's leg trades into the basket row", () => {
    const steps = [AAPL, NVDA, GOOGL].map((a, i) => ({ id: `s${i}`, assetAddress: a, symbol: "X", side: "buy" as const, targetUsd: 1.8, sellAmountUsdc: "1800000", status: "confirmed" as const, txHash: hash(10 + i) }));
    const exec: PortfolioExecution = { id: "e1", owner: ME, status: "COMPLETE", totalUsd: 5.4, steps, createdAt: 1_000_000, updatedAt: 1_000_000 };
    const trades = steps.map((s, i) => trade({ id: `t${i}`, txHash: s.txHash, assetAddress: s.assetAddress }));
    const receipts = new Map(steps.map((s, i) => [s.txHash, ok(100 + i)]));
    const items = buildTimeline(input({ executions: [exec], trades, receipts }));
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("portfolio-build");
    expect(items[0]!.amountUsd).toBeCloseTo(5.4);
    expect(items[0]!.legs?.map((l) => l.symbol)).toEqual(["AAPLc", "NVDAc", "GOOGLc"]);
    expect(items[0]!.verified).toBe(true);
  });

  it("counts only the legs that landed, and says how many were planned", () => {
    const steps = [
      { id: "s0", assetAddress: AAPL, symbol: "AAPLc", side: "buy" as const, targetUsd: 2, sellAmountUsdc: "2000000", status: "confirmed" as const, txHash: hash(1) },
      { id: "s1", assetAddress: NVDA, symbol: "NVDAc", side: "buy" as const, targetUsd: 2, sellAmountUsdc: "2000000", status: "failed" as const, errorCode: "SLIPPAGE" },
    ];
    const exec: PortfolioExecution = { id: "e1", owner: ME, status: "PARTIALLY_FILLED", totalUsd: 4, steps, createdAt: 1_000_000, updatedAt: 1_000_000 };
    const [row] = buildTimeline(input({ executions: [exec], receipts: new Map([[hash(1), ok(1)]]) }));
    expect(row!.amountUsd).toBe(2);
    expect(row!.metadata).toMatchObject({ completed: 1, total: 2, plannedUsd: 4 });
    expect(row!.legs?.[1]?.status).toBe("failed");
  });

  /** An AutoInvest run buys three stocks in one transaction; the keeper writes one trade row per leg. */
  it("groups trade rows that share a hash into one auto-invest row", () => {
    const tx = hash(7);
    const trades = [AAPL, NVDA, GOOGL].map((a, i) => trade({ id: `a${i}`, txHash: tx, assetAddress: a, provider: "auto-invest", usdValue: 1.67, status: "confirmed" }));
    const items = buildTimeline(input({ trades, receipts: new Map([[tx, ok(50)]]) }));
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("auto-invest");
    expect(items[0]!.amountUsd).toBeCloseTo(5.01);
    expect(items[0]!.legs).toHaveLength(3);
  });

  it("treats the same purchase posted twice as one purchase", () => {
    const tx = hash(8);
    const trades = [trade({ id: "d1", txHash: tx, assetAddress: AAPL }), trade({ id: "d2", txHash: tx, assetAddress: AAPL, createdAt: 1_000_500 })];
    const items = buildTimeline(input({ trades, receipts: new Map([[tx, ok(50)]]) }));
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("buy");
    expect(items[0]!.id).toBe("trade:d1");
  });

  /** Buying for someone writes a trade row and a gift row on the same hash; the gift is the story. */
  it("shows a gift bought for someone once, as the gift, with the purchase price on it", () => {
    const tx = hash(9);
    const gift: GiftRecord = { id: "g1", kind: "buy-for-recipient", sender: ME, recipient: OTHER, assetAddress: AAPL, rawAmount: "401447", memo: "0x00", txHash: tx, status: "submitted", createdAt: 1_000_000, verifiedAt: 1_000_000 };
    const items = buildTimeline(input({ trades: [trade({ id: "t9", txHash: tx, assetAddress: AAPL, usdValue: 1.32, provider: "okx", recipient: OTHER })], gifts: [gift], receipts: new Map([[tx, ok(60)]]) }));
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("send");
    expect(items[0]!.amountUsd).toBe(1.32);
    expect(items[0]!.provider).toBe("okx");
    expect(items[0]!.counterparty).toBe(OTHER);
  });

  it("folds gift links funded in one transaction into one row with a count", () => {
    const tx = hash(11);
    const gifts: GiftRecord[] = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, kind: "claim-link", sender: ME, recipient: "0x0000000000000000000000000000000000000000", assetAddress: AAPL, rawAmount: "100000", memo: "0x00", txHash: tx, status: "submitted", createdAt: 1_000_000 + i, escrowId: "0x01", expiresAt: 9_999_999_999_999, verifiedAt: 1_000_000 }));
    const items = buildTimeline(input({ gifts, receipts: new Map([[tx, ok(70)]]) }));
    expect(items).toHaveLength(1);
    expect(items[0]!.count).toBe(10);
    expect(items[0]!.rawAmount).toBe("1000000");
    expect((items[0]!.metadata as { giftIds: string[] }).giftIds).toHaveLength(10);
  });
});

describe("what the chain shows that no record explains", () => {
  const transfer = (tx: Hash, from: Address, to: Address, block: number, timestamp?: number) => ({ txHash: tx, blockNumber: BigInt(block), asset: AAPL, from, to, value: 100n, timestamp });

  it("adds a transfer nobody recorded, and drops one a record already stands for", () => {
    const recorded = hash(20);
    const unknown = hash(21);
    // The recorded trade carries the app clock (1,000 s); the unexplained transfer carries its block time (500 s).
    const items = buildTimeline(input({ trades: [trade({ id: "t20", txHash: recorded, assetAddress: AAPL })], transfers: [transfer(recorded, OTHER, ME, 10), transfer(unknown, OTHER, ME, 11, 500)] }));
    expect(items.map((i) => i.id)).toEqual(["trade:t20", `chain:${unknown}:${AAPL}:in`]);
    expect(items[1]!.timestamp).toBe(500);
    // The transfer is proof enough: no receipt needed.
    expect(items[0]!.verified).toBe(true);
  });

  /**
   * A swap filled across two pools delivers the stock as two Transfer logs in one transaction.
   * That used to be two "Received" rows for one receipt, sharing an id, which React flagged as
   * duplicate keys on the home page.
   */
  it("folds several transfers of one asset in one direction into one row with the total", () => {
    const tx = hash(40);
    const items = buildTimeline(input({ transfers: [transfer(tx, OTHER, ME, 40), { ...transfer(tx, OTHER, ME, 40), value: 250n }] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(`chain:${tx}:${AAPL}:in`);
    expect(items[0]!.rawAmount).toBe("350");
    expect(items[0]!.counterparty).toBe(OTHER);
  });

  it("keeps a send and a receive of the same asset in one transaction as two rows", () => {
    const tx = hash(41);
    const items = buildTimeline(input({ transfers: [transfer(tx, OTHER, ME, 41), transfer(tx, ME, OTHER, 41)] }));
    expect(items.map((i) => i.id).sort()).toEqual([`chain:${tx}:${AAPL}:in`, `chain:${tx}:${AAPL}:out`]);
  });

  /**
   * A claim-link gift moves twice: sender → escrow when it is funded, escrow → claimant when it
   * is taken. The claim used to surface as an unexplained "Received from 0x8D9f…" on the sender's
   * side and as a duplicate on the claimant's; both hashes belong to the gift.
   */
  it("gives the claimant the claim transaction and hides the escrow hop on both sides", () => {
    const deposit = hash(30);
    const claim = hash(31);
    const gift: GiftRecord = { id: "g30", kind: "claim-link", sender: OTHER, recipient: ME, assetAddress: AAPL, rawAmount: "2000000", memo: "0x00", txHash: deposit, claimTx: claim, status: "claimed", createdAt: 1_000_000, escrowId: "0x01", expiresAt: 9_999_999_999_999, verifiedAt: 1_000_000 };
    const escrow = "0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55" as Address;
    const items = buildTimeline(input({ gifts: [gift], transfers: [transfer(claim, escrow, ME, 12)], receipts: new Map([[claim, ok(12)]]) }));
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({ type: "receive", txHash: claim, counterparty: OTHER, verified: true });
    // The sender's side of the same gift: one row, marked claimed, no stray escrow transfer.
    const sender = buildTimeline(input({ owner: OTHER, gifts: [gift], transfers: [transfer(deposit, OTHER, escrow, 11), transfer(claim, escrow, ME, 12)], receipts: new Map([[deposit, ok(11)]]) }));
    expect(sender).toHaveLength(1);
    expect(sender[0]!.metadata).toMatchObject({ kind: "claim-link", status: "claimed" });
  });
});

describe("pools", () => {
  const pool: PoolRecord = { id: "pool_1", onchainId: "0x01", creator: ME, gateMode: "open", gateAddress: "0x0000000000000000000000000000000000000000", slots: 5, legs: [{ token: AAPL, amountPerClaim: "200000" }], expiry: 9_999_999_999_999, lockedUntil: 0, visibility: "public", verified: false, quests: [], memo: "0x00", txHash: hash(40), status: "live", createdAt: 1_000_000, verifiedAt: 1_000_000 };

  it("shows the funding deposit as one row worth every share", () => {
    const [row] = buildTimeline(input({ pools: [pool], receipts: new Map([[hash(40), ok(80)]]) }));
    expect(row!.type).toBe("pool-create");
    expect(row!.rawAmount).toBe("1000000");
    expect(row!.metadata).toMatchObject({ poolId: "pool_1", slots: 5 });
  });

  it("shows a claimed share against the pool it came from, and not again from the transfer scan", () => {
    const claim: PoolClaim = { poolId: "pool_1", claimant: OTHER, status: "confirmed", questProof: {}, txHash: hash(41), createdAt: 1_000_000 };
    const poolAddr = "0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10" as Address;
    const items = buildTimeline(input({ owner: OTHER, poolClaims: [{ claim, pool }], transfers: [{ txHash: hash(41), blockNumber: 81n, asset: AAPL, from: poolAddr, to: OTHER, value: 200000n }], receipts: new Map([[hash(41), ok(81)]]) }));
    expect(items).toHaveLength(1);
    expect(items[0]!).toMatchObject({ type: "pool-claim", symbol: "AAPLc", rawAmount: "200000", counterparty: ME, verified: true });
  });

  it("does not show a ticket that was issued but never used", () => {
    const claim: PoolClaim = { poolId: "pool_1", claimant: OTHER, status: "issued", questProof: {}, createdAt: 1_000_000 };
    expect(buildTimeline(input({ owner: OTHER, poolClaims: [{ claim, pool }] }))).toHaveLength(0);
  });
});

describe("what the server has not matched to the chain", () => {
  /**
   * The write routes take any hash a browser sends; the receipt decides afterwards. Until the server
   * has matched a record it is pending even when the receipt says success, and a record the receipt
   * contradicted (filed under a wallet the transfer never touched) is not this wallet's at all.
   */
  it("keeps an unmatched record pending despite a successful receipt, and hides a contradicted one", () => {
    // Filed a moment ago: still inside the window a pending record is shown for.
    const unmatched = trade({ id: "u", txHash: hash(70), assetAddress: AAPL, verifiedAt: undefined, createdAt: Date.now() });
    const contradicted = trade({ id: "c", txHash: hash(71), assetAddress: NVDA, status: "failed", verifyNote: "The stock did not arrive in that wallet in this transaction.", verifiedAt: undefined });
    const items = buildTimeline(input({ trades: [unmatched, contradicted], receipts: new Map([[hash(70), ok(1)], [hash(71), ok(2)]]) }));
    expect(items.map((i) => i.id)).toEqual(["trade:u"]);
    expect(items[0]!.verified).toBe(false);
  });

  it("takes the wallet's own transfer index as proof even before the server matched the record", () => {
    const t = trade({ id: "w", txHash: hash(72), assetAddress: AAPL, verifiedAt: undefined });
    const items = buildTimeline(input({ trades: [t], transfers: [{ txHash: hash(72), blockNumber: 5n, asset: AAPL, from: OTHER, to: ME, value: 1n }] }));
    expect(items[0]!.verified).toBe(true);
  });
});

describe("ordering and time", () => {
  it("uses the block time when the receipt has it, and the app clock otherwise", () => {
    const withBlock = trade({ id: "a", txHash: hash(50), assetAddress: AAPL, createdAt: 1_000_000 });
    const withoutBlock = trade({ id: "b", txHash: hash(51), assetAddress: NVDA, createdAt: 2_000_000 });
    const items = buildTimeline(input({ trades: [withBlock, withoutBlock], receipts: new Map([[hash(50), ok(1, 5_000)], [hash(51), ok(2)]]) }));
    // The block says 5,000 s; the app clock on the other row says 2,000 s. The block wins, and the newer row sorts first.
    expect(items.map((i) => i.id)).toEqual(["trade:a", "trade:b"]);
    expect(items[0]!.timestamp).toBe(5_000);
    expect(items[1]!.timestamp).toBe(2_000);
  });

  it("marks a reverted record failed and an unmined one pending, never both", () => {
    const items = buildTimeline(input({ trades: [trade({ id: "r", txHash: hash(60), assetAddress: AAPL }), trade({ id: "p", txHash: hash(61), assetAddress: NVDA })], receipts: new Map([[hash(60), { status: "reverted", blockNumber: 3 }]]) }));
    const reverted = items.find((i) => i.id === "trade:r")!;
    const pending = items.find((i) => i.id === "trade:p")!;
    expect(reverted.verified).toBe(false);
    expect(reverted.metadata).toEqual({ failed: true });
    expect(pending.verified).toBe(false);
    expect(pending.metadata).toBeUndefined();
  });
});

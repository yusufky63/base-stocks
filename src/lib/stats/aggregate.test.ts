import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import type { GiftRecord } from "@/domain/gift";
import type { PoolClaim, PoolRecord } from "@/domain/pool";
import type { PortfolioExecution } from "@/domain/portfolio";
import type { AutomationRule } from "@/domain/community";
import type { EarnActionRecord, TradeRecord } from "@/db/repositories";
import type { ReceiptState } from "@/services/receipt-service";
import { aggregateStats, type StatsInput } from "./aggregate";

const A = "0xeaa823ab4c4ee00283d8ed7be713ddf8a5ba0fac" as Address;
const B = "0xbfa6a45dd534d39df47a3f3d2f2b6e88416f9831" as Address;
const C = "0x2ce3e3295a48b52deaf67f1914d25a063ff91b6b" as Address;
const AAPL = "0xb200000000000000000000c2e324d24d7eecd1fb" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fe4908108c" as Address;
const GOOGL = "0xb2000000000000000000002d0ba3164cc74f58b7" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const NOW = Date.UTC(2026, 8, 5, 18, 0, 0);
const DAY = 24 * 3600_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;
const ok = (n: number, atMs?: number): [string, ReceiptState] => [hash(n), { status: "success", blockNumber: n, blockTime: atMs ? Math.floor(atMs / 1000) : undefined }];

/** Prices per raw unit, chosen so units × price is easy to check: 1 token = $1. */
const assets = [
  { canonicalId: AAPL, address: AAPL, symbol: "AAPLc", underlying: "AAPL", decimals: 8, priceUsd: 1 },
  { canonicalId: NVDA, address: NVDA, symbol: "NVDAc", underlying: "NVDA", decimals: 8, priceUsd: 1 },
  { canonicalId: GOOGL, address: GOOGL, symbol: "GOOGLc", underlying: "GOOGL", decimals: 8, priceUsd: null },
];

/** Records here are ones the server has already matched to the chain (`verifiedAt`), as every counted record must be. */
function trade(over: Partial<TradeRecord> & { id: string; assetAddress: Address }): TradeRecord {
  return { owner: A, side: "buy", sellAmount: "1800000", buyAmount: "100000000", usdValue: 1.8, provider: "kyber", status: "submitted", createdAt: NOW - DAY, verifiedAt: NOW - DAY, ...over };
}

function base(over: Partial<StatsInput> = {}): StatsInput {
  return { now: NOW, assets, trades: [], gifts: [], executions: [], earnActions: [], pools: [], poolClaims: [], rules: [], profiles: [], baskets: [], watchlists: { entries: 0, wallets: 0 }, portfolioWallets: 0, digests: { count: 0, costUsd: 0 }, aiSpendUsd: 0, receipts: new Map(), ...over };
}

describe("one (transaction, stock, side) is one trade", () => {
  /** Production shape: a four-leg basket writes an execution and four trade rows; volume is the basket's, once. */
  it("does not count a basket's legs twice", () => {
    const steps = [AAPL, NVDA, GOOGL, AAPL].map((a, i) => ({ id: `s${i}`, assetAddress: i === 3 ? NVDA : a, symbol: "X", side: "buy" as const, targetUsd: 1.8, sellAmountUsdc: "1800000", status: "confirmed" as const, txHash: hash(10 + i) }));
    const exec: PortfolioExecution = { id: "e1", owner: A, status: "COMPLETE", totalUsd: 7.2, steps, createdAt: NOW - DAY, updatedAt: NOW - DAY };
    const trades = steps.map((s, i) => trade({ id: `t${i}`, txHash: s.txHash, assetAddress: s.assetAddress }));
    const stats = aggregateStats(base({ executions: [exec], trades, receipts: new Map(steps.map((_, i) => ok(10 + i))) }));
    expect(stats.windows.all.trades).toBe(4);
    expect(stats.windows.all.tradeVolumeUsd).toBeCloseTo(7.2);
    expect(stats.windows.all.basketsBuilt).toBe(1);
    expect(stats.strategies.executions).toMatchObject({ started: 1, complete: 1, legsConfirmed: 4, usd: 7.2 });
  });

  it("still counts a leg whose trade row never arrived", () => {
    const steps = [{ id: "s0", assetAddress: AAPL, symbol: "AAPLc", side: "buy" as const, targetUsd: 2, sellAmountUsdc: "2000000", status: "confirmed" as const, txHash: hash(1) }];
    const exec: PortfolioExecution = { id: "e1", owner: A, status: "COMPLETE", totalUsd: 2, steps, createdAt: NOW - DAY, updatedAt: NOW - DAY };
    const stats = aggregateStats(base({ executions: [exec], receipts: new Map([ok(1)]) }));
    expect(stats.windows.all.trades).toBe(1);
    expect(stats.windows.all.tradeVolumeUsd).toBe(2);
    expect(stats.trading.byProvider[0]).toMatchObject({ provider: "basket", count: 1, usd: 2 });
  });

  /** An AutoInvest run: one hash, three rows, three stocks — three trades, one transaction. */
  it("counts every stock of an auto-invest run, and the run once", () => {
    const rows = [AAPL, NVDA, GOOGL].map((a, i) => trade({ id: `a${i}`, txHash: hash(7), assetAddress: a, provider: "auto-invest", usdValue: 1.67, status: "confirmed" }));
    const rule: AutomationRule = { id: "r1", owner: A, type: "recurring-basket", status: "active", config: { mode: "auto", onchain: { contract: ZERO, planId: "1", syncedAt: NOW, status: "active", nextRunAt: NOW, lastRunAt: NOW, runs: 1, amountPerRun: "5000000", interval: 86400, expiryAt: 0, maxSlippageBps: 100 }, history: [{ at: NOW - DAY, ok: true, via: "keeper", txHash: hash(7), spentUsd: 5.01 }] }, createdAt: NOW - 2 * DAY, updatedAt: NOW };
    const stats = aggregateStats(base({ trades: rows, rules: [rule], receipts: new Map([ok(7)]) }));
    expect(stats.windows.all.trades).toBe(3);
    expect(stats.windows.all.tradeVolumeUsd).toBeCloseTo(5.01);
    expect(stats.windows.all.planRuns).toBe(1);
    expect(stats.strategies.autoInvest).toMatchObject({ plans: 1, active: 1, runs: 1, keeperRuns: 1, usd: 5.01 });
    expect(stats.verification.verified).toBe(1);
  });

  it("collapses the same trade posted twice and says so", () => {
    const stats = aggregateStats(base({ trades: [trade({ id: "d1", txHash: hash(8), assetAddress: AAPL }), trade({ id: "d2", txHash: hash(8), assetAddress: AAPL, createdAt: NOW - DAY + 1 })], receipts: new Map([ok(8)]) }));
    expect(stats.windows.all.trades).toBe(1);
    expect(stats.verification.duplicatesCollapsed).toBe(1);
  });
});

describe("only what the chain confirmed", () => {
  it("leaves reverted and unmined records out of every total", () => {
    const trades = [trade({ id: "ok", txHash: hash(1), assetAddress: AAPL }), trade({ id: "rev", txHash: hash(2), assetAddress: NVDA }), trade({ id: "pend", txHash: hash(3), assetAddress: GOOGL }), trade({ id: "none", assetAddress: AAPL })];
    const stats = aggregateStats(base({ trades, receipts: new Map([ok(1), [hash(2), { status: "reverted", blockNumber: 2 }]]) }));
    expect(stats.windows.all.trades).toBe(1);
    expect(stats.windows.all.tradeVolumeUsd).toBe(1.8);
    expect(stats.windows.all.reverted).toBe(1);
    expect(stats.verification).toMatchObject({ verified: 1, reverted: 1, pending: 1, withoutTx: 1 });
    expect(stats.ledger.map((l) => l.txHash)).toEqual([hash(1)]);
  });

  it("counts a wallet once no matter how much it did, and only when something landed", () => {
    const trades = [trade({ id: "1", txHash: hash(1), assetAddress: AAPL, owner: A }), trade({ id: "2", txHash: hash(2), assetAddress: NVDA, owner: A }), trade({ id: "3", txHash: hash(3), assetAddress: NVDA, owner: B })];
    const stats = aggregateStats(base({ trades, receipts: new Map([ok(1), ok(2)]) }));
    expect(stats.windows.all.wallets).toBe(1);
    expect(stats.people.transactingWallets).toBe(1);
    // B is known (it tried) but did not transact.
    expect(stats.people.knownWallets).toBe(2);
  });
});

describe("gifts", () => {
  it("counts a gift bought for someone as one purchase and one gift", () => {
    const gift: GiftRecord = { id: "g1", kind: "buy-for-recipient", sender: A, recipient: B, assetAddress: AAPL, rawAmount: "401447", memo: "0x00", txHash: hash(9), status: "submitted", createdAt: NOW - DAY, verifiedAt: NOW - DAY };
    const stats = aggregateStats(base({ trades: [trade({ id: "t9", txHash: hash(9), assetAddress: AAPL, usdValue: 1.32, provider: "okx", recipient: B })], gifts: [gift], receipts: new Map([ok(9)]) }));
    expect(stats.windows.all.trades).toBe(1);
    expect(stats.windows.all.tradeVolumeUsd).toBe(1.32);
    expect(stats.windows.all.directGifts).toBe(1);
    expect(stats.gifts.direct).toMatchObject({ buyForRecipient: 1, sendExisting: 0 });
    expect(stats.trading.byAsset[0]).toMatchObject({ symbol: "AAPLc", buys: 1, gifted: 0.00401447 });
  });

  it("counts ten links funded in one transaction as ten links, and tells claimed from open from expired", () => {
    const link = (i: number, over: Partial<GiftRecord> = {}): GiftRecord => ({ id: `l${i}`, kind: "claim-link", sender: A, recipient: ZERO, assetAddress: AAPL, rawAmount: "100000000", memo: "0x00", txHash: hash(11), status: "submitted", createdAt: NOW - 2 * DAY, escrowId: "0x01", expiresAt: NOW + DAY, verifiedAt: NOW - 2 * DAY, ...over });
    const gifts = [
      ...Array.from({ length: 7 }, (_, i) => link(i)),
      link(7, { status: "claimed", recipient: C, claimTx: hash(12) }),
      link(8, { status: "reclaimed", claimTx: hash(13) }),
      link(9, { expiresAt: NOW - 1 }),
    ];
    const stats = aggregateStats(base({ gifts, receipts: new Map([ok(11), ok(12)]) }));
    expect(stats.gifts.links).toMatchObject({ created: 10, claimed: 1, reclaimed: 1, open: 7, expired: 1, valueUsdToday: 10 });
    expect(stats.windows.all.linksCreated).toBe(10);
    expect(stats.windows.all.linksClaimed).toBe(1);
    // The claimant transacted (the claim landed); the sender too.
    expect(stats.people.transactingWallets).toBe(2);
  });

  it("values pools at today's price and counts claims the log or the receipt confirmed", () => {
    const pool: PoolRecord = { id: "p1", onchainId: "0x01", creator: A, gateMode: "open", gateAddress: ZERO, slots: 5, legs: [{ token: AAPL, amountPerClaim: "100000000" }, { token: NVDA, amountPerClaim: "50000000" }], expiry: NOW + DAY, lockedUntil: 0, visibility: "public", verified: false, quests: [], memo: "0x00", txHash: hash(20), status: "live", createdAt: NOW - DAY, verifiedAt: NOW - DAY };
    // B's claim was reported by the page and not yet matched to a `PoolClaimed` log: it waits, it does not count.
    const claims: PoolClaim[] = [
      { poolId: "p1", claimant: B, status: "confirmed", questProof: {}, txHash: hash(21), createdAt: NOW - DAY },
      { poolId: "p1", claimant: C, status: "reconciled", questProof: {}, txHash: hash(22), blockNumber: 22, createdAt: NOW - DAY },
      { poolId: "p1", claimant: A, status: "issued", questProof: {}, createdAt: NOW - DAY },
    ];
    const stats = aggregateStats(base({ pools: [pool], poolClaims: claims, receipts: new Map([ok(20), ok(21)]) }));
    expect(stats.gifts.pools).toMatchObject({ created: 1, live: 1, slots: 5, claimsConfirmed: 1, claimsReconciled: 1, sharesValueUsdToday: 7.5 });
    expect(stats.windows.all.poolClaims).toBe(1);
    expect(stats.trading.byAsset.find((a) => a.symbol === "AAPLc")?.gifted).toBe(1);
  });
});

describe("what the server has not matched to the chain", () => {
  it("counts nothing the server has not matched, and nothing the chain contradicted", () => {
    const unmatched = trade({ id: "u", txHash: hash(1), assetAddress: AAPL, verifiedAt: undefined });
    const contradicted = trade({ id: "c", txHash: hash(2), assetAddress: NVDA, status: "failed", verifyNote: "The stock did not arrive in that wallet in this transaction.", verifiedAt: undefined });
    const reverted = trade({ id: "r", txHash: hash(3), assetAddress: GOOGL, status: "failed", verifyNote: "reverted", verifiedAt: undefined });
    const stats = aggregateStats(base({ trades: [unmatched, contradicted, reverted], receipts: new Map([ok(1), ok(2), [hash(3), { status: "reverted", blockNumber: 3 }]]) }));
    expect(stats.windows.all.trades).toBe(0);
    expect(stats.windows.all.reverted).toBe(1);
    expect(stats.verification).toMatchObject({ verified: 2, reverted: 1, disowned: 1 });
  });
});

describe("earn, windows and days", () => {
  it("sums deposits and withdrawals by venue", () => {
    const earn = (id: string, action: "deposit" | "withdraw", provider: string, usd: number, n: number, at: number): EarnActionRecord => ({ id, owner: A, opportunityId: `${provider}:x`, provider, action, amount: String(usd * 1e6), usdValue: usd, txHash: hash(n), createdAt: at, verifiedAt: at });
    const stats = aggregateStats(base({ earnActions: [earn("1", "deposit", "morpho", 10, 1, NOW - 2 * DAY), earn("2", "deposit", "aave", 5, 2, NOW - 10 * DAY), earn("3", "withdraw", "morpho", 4, 3, NOW - 3600_000)], receipts: new Map([ok(1), ok(2), ok(3)]) }));
    expect(stats.earn.deposits).toEqual({ count: 2, usd: 15 });
    expect(stats.earn.withdrawals).toEqual({ count: 1, usd: 4 });
    expect(stats.windows["7d"].earnDepositUsd).toBe(10);
    expect(stats.windows["24h"].earnWithdrawalUsd).toBe(4);
    expect(stats.windows["24h"].earnDeposits).toBe(0);
  });

  it("keeps liquidity positions apart from USDC lending", () => {
    const rec = (id: string, provider: string, action: EarnActionRecord["action"], usd: number, n: number): EarnActionRecord => ({ id, owner: A, opportunityId: `lp:${provider}:1`, provider, action, amount: "1000000", usdValue: usd, txHash: hash(n), createdAt: NOW - DAY, verifiedAt: NOW - DAY });
    const stats = aggregateStats(base({ earnActions: [rec("1", "uniswap", "deposit", 20, 1), rec("2", "aerodrome", "collect", 0.5, 2), rec("3", "uniswap", "withdraw", 19, 3), rec("4", "morpho", "deposit", 10, 4)], receipts: new Map([ok(1), ok(2), ok(3), ok(4)]) }));
    expect(stats.earn.deposits).toEqual({ count: 1, usd: 10 });
    expect(stats.earn.liquidity).toEqual({ added: { count: 1, usd: 20 }, removed: { count: 1, usd: 19 }, collected: { count: 1, usd: 0.5 } });
    expect(stats.windows.all.earnDepositUsd).toBe(10);
    expect(stats.windows.all.lpAdds).toBe(1);
    expect(stats.windows.all.lpAddUsd).toBe(20);
    expect(stats.ledger.map((l) => l.kind).sort()).toEqual(["earn-deposit", "lp-add", "lp-collect", "lp-remove"]);
  });

  it("dates an event by its block when the receipt knows it, and buckets days in UTC", () => {
    const eightDaysAgo = NOW - 8 * DAY;
    // The app clock says yesterday, the block says eight days ago: the block wins, so it leaves the 7-day window.
    const t = trade({ id: "old", txHash: hash(1), assetAddress: AAPL, createdAt: NOW - DAY });
    const stats = aggregateStats(base({ trades: [t], receipts: new Map([ok(1, eightDaysAgo)]) }));
    expect(stats.windows["7d"].trades).toBe(0);
    expect(stats.windows["30d"].trades).toBe(1);
    const day = new Date(eightDaysAgo).toISOString().slice(0, 10);
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily.find((d) => d.day === day)).toMatchObject({ trades: 1, volumeUsd: 1.8, events: 1, wallets: 1 });
    expect(stats.ledger[0]?.at).toBe(Math.floor(eightDaysAgo / 1000) * 1000);
  });
});

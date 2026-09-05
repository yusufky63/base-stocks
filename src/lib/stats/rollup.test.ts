import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import type { TradeRecord } from "@/db/repositories";
import type { ReceiptState } from "@/services/receipt-service";
import { aggregateStats, buildDayRollup, dayKey, type StatsInput } from "./aggregate";

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
const DAY = 24 * 3600_000;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const A = "0x1000000000000000000000000000000000000001" as Address;
const B = "0x2000000000000000000000000000000000000002" as Address;

const assets = [
  { canonicalId: AAPL.toLowerCase(), address: AAPL, symbol: "AAPLc", underlying: "AAPL", decimals: 8, priceUsd: 300 },
  { canonicalId: NVDA.toLowerCase(), address: NVDA, symbol: "NVDAc", underlying: "NVDA", decimals: 8, priceUsd: 200 },
];
const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, "0")}` as Hash;

/** A verified trade `daysAgo` days back; the receipt's block time is what dates it. */
function trade(n: number, daysAgo: number, over: Partial<TradeRecord> = {}): { t: TradeRecord; r: [string, ReceiptState] } {
  const at = NOW - daysAgo * DAY;
  return {
    t: { id: `t${n}`, owner: A, side: "buy", assetAddress: AAPL, sellAmount: "10000000", buyAmount: "3333333", usdValue: 10, provider: "kyber", txHash: hash(n), status: "confirmed", createdAt: at, verifiedAt: at + 1000, feeBps: 10, ...over },
    r: [hash(n), { status: "success", blockNumber: n, blockTime: Math.floor(at / 1000) }],
  };
}

function base(over: Partial<StatsInput> = {}): StatsInput {
  return { now: NOW, assets, trades: [], gifts: [], executions: [], earnActions: [], pools: [], poolClaims: [], rules: [], profiles: [], baskets: [], watchlists: { entries: 0, wallets: 0 }, portfolioWallets: 0, digests: { count: 0, costUsd: 0 }, aiSpendUsd: 0, receipts: new Map(), ...over };
}

describe("daily rollups", () => {
  // Three old trades on two days by two wallets, two recent ones by one of them.
  const old1 = trade(1, 60);
  const old2 = trade(2, 60, { owner: B, assetAddress: NVDA, usdValue: 20 });
  const old3 = trade(3, 50, { side: "sell", usdValue: 5, feeBps: undefined });
  const new1 = trade(4, 3);
  const new2 = trade(5, 1, { owner: B, usdValue: 40 });
  const all = [old1, old2, old3, new1, new2];
  const full = base({ trades: all.map((x) => x.t), receipts: new Map(all.map((x) => x.r)) });

  it("adds up to the same totals as reading every record", () => {
    const direct = aggregateStats(full);
    const day60 = dayKey(NOW - 60 * DAY);
    const day50 = dayKey(NOW - 50 * DAY);
    const rollups = [buildDayRollup(full, day60), buildDayRollup(full, day50)];
    const liveSince = NOW - 40 * DAY;
    const live = base({ trades: [new1.t, new2.t], receipts: new Map([new1.r, new2.r]), rollups, liveSince });
    const split = aggregateStats(live);

    expect(split.windows.all.trades).toBe(direct.windows.all.trades);
    expect(split.windows.all.tradeVolumeUsd).toBeCloseTo(direct.windows.all.tradeVolumeUsd, 6);
    expect(split.windows.all.sells).toBe(direct.windows.all.sells);
    expect(split.windows.all.wallets).toBe(2);
    expect(split.windows["30d"]).toEqual(direct.windows["30d"]);
    expect(split.trading.byAsset).toEqual(direct.trading.byAsset);
    expect(split.trading.byProvider).toEqual(direct.trading.byProvider);
    expect(split.trading.integratorFeeUsd).toBeCloseTo(direct.trading.integratorFeeUsd, 6);
    expect(split.verification.verified).toBe(direct.verification.verified);
    expect(split.people.transactingWallets).toBe(direct.people.transactingWallets);
    expect(split.rollup).toEqual({ days: 2, through: day50, liveSince });
  });

  it("keeps a day's own events and wallets, nothing from its neighbours", () => {
    const r = buildDayRollup(full, dayKey(NOW - 60 * DAY));
    expect(r.summary.trades).toBe(2);
    expect(r.summary.tradeVolumeUsd).toBe(30);
    expect(r.wallets.sort()).toEqual([A.toLowerCase(), B.toLowerCase()].sort());
    expect(r.byAsset[AAPL.toLowerCase()]?.buys).toBe(1);
    expect(r.byAsset[NVDA.toLowerCase()]?.buys).toBe(1);
    expect(r.feeUsd).toBeCloseTo(0.03, 8);
    expect(r.verifiedTx).toBe(2);
  });

  /** A rollup inside the live range would count its day twice; the live boundary wins. */
  it("ignores a rollup that overlaps the live window", () => {
    const rollups = [buildDayRollup(full, dayKey(NOW - 3 * DAY))];
    const stats = aggregateStats(base({ trades: [new1.t, new2.t], receipts: new Map([new1.r, new2.r]), rollups, liveSince: NOW - 40 * DAY }));
    expect(stats.windows.all.trades).toBe(2);
    expect(stats.rollup.days).toBe(0);
  });

  it("carries the integrator fee from each record's own rate", () => {
    const stats = aggregateStats(full);
    // Four buys at 10 bps on $10, $20, $10, $40 = $0.08; the sell carried no rate.
    expect(stats.trading.integratorFeeUsd).toBeCloseTo(0.08, 8);
  });
});

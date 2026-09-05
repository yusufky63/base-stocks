import { describe, expect, it } from "vitest";
import { buyLegBlockedReason, hasMeaningfulChange, legPoolShare, premiumBeyondFloor, referenceGap, referenceGapNote, sortByTradingStatus, tradingStatus } from "./trading-status";

const asset = (over: { status?: "active" | "paused"; totalSupply?: string } = {}) => ({
  status: over.status ?? ("active" as const),
  totalSupply: over.totalSupply ?? "100000000000",
});
const price = (liquidityUsd: number | null, volume24hUsd: number | null = null, marketChange24hPct: number | null = 1.2) => ({ liquidityUsd, volume24hUsd, marketChange24hPct });

describe("trading status", () => {
  it("puts issuance and pauses ahead of any liquidity question", () => {
    expect(tradingStatus(asset({ status: "paused" }), price(5_000_000)).status).toBe("paused");
    expect(tradingStatus(asset({ totalSupply: "0" }), price(5_000_000)).status).toBe("not-issued");
  });

  it("classifies by liquidity across the whole range", () => {
    expect(tradingStatus(asset(), price(2_100_000)).status).toBe("tradable");
    expect(tradingStatus(asset(), price(27_905)).status).toBe("thin");
    expect(tradingStatus(asset(), price(108)).status).toBe("very-thin");
    expect(tradingStatus(asset(), price(0)).status).toBe("no-pool");
    expect(tradingStatus(asset(), price(null)).status).toBe("no-pool");
    expect(tradingStatus(asset(), null).status).toBe("no-pool");
  });

  it("holds the thresholds exactly at the boundary", () => {
    expect(tradingStatus(asset(), price(100_000)).status).toBe("tradable");
    expect(tradingStatus(asset(), price(99_999)).status).toBe("thin");
    expect(tradingStatus(asset(), price(10_000)).status).toBe("thin");
    expect(tradingStatus(asset(), price(9_999)).status).toBe("very-thin");
    expect(tradingStatus(asset(), price(1)).status).toBe("very-thin");
  });

  /**
   * The bug the six new listings exposed: a $9,920 pool was labelled "No pool yet" while its own
   * detail line printed the pool size. A label must never contradict the text under it.
   */
  it("never says there is no pool while reporting one", () => {
    for (const liq of [1, 108, 515, 3_004, 9_920, 9_999]) {
      const view = tradingStatus(asset(), price(liq));
      expect(view.label).not.toBe("No pool yet");
      expect(view.detail).toContain("liquidity");
    }
    const empty = tradingStatus(asset(), price(0));
    expect(empty.label).toBe("No pool yet");
    expect(empty.detail).not.toMatch(/\$\d/);
  });

  it("warns about slippage exactly where it matters", () => {
    expect(tradingStatus(asset(), price(108)).detail).toContain("expect heavy slippage");
    expect(tradingStatus(asset(), price(27_905)).detail).not.toContain("slippage");
    expect(tradingStatus(asset(), price(2_100_000)).detail).not.toContain("slippage");
  });

  it("appends 24h volume only when there is some", () => {
    expect(tradingStatus(asset(), price(2_100_000, 6_200_000)).detail).toBe("$2.1M liquidity · $6.2M 24h");
    expect(tradingStatus(asset(), price(2_100_000, 0)).detail).toBe("$2.1M liquidity");
    expect(tradingStatus(asset(), price(2_100_000, null)).detail).toBe("$2.1M liquidity");
  });

  /**
   * The second thing the six listings exposed: a pool created hours ago has no honest "24h ago",
   * so the DEX reported Microsoft down 82% while its price sat 1% from the Chainlink reference.
   */
  it("only trusts a 24h move from a market with real depth", () => {
    expect(hasMeaningfulChange(tradingStatus(asset(), price(2_100_000)).status, price(2_100_000))).toBe(true);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(100_000)).status, price(100_000))).toBe(true);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(27_905)).status, price(27_905))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(108)).status, price(108))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(0)).status, price(0))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset({ totalSupply: "0" }), price(0)).status, price(0))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset({ status: "paused" }), price(5_000_000)).status, price(5_000_000))).toBe(false);
  });

  /**
   * The bug in the first cut: Amazon at $10,071 kept a -63% headline while Microsoft at $9,979 lost
   * it, when the two were equally meaningless. Seventy-one dollars of depth decides nothing.
   */
  it("does not let a market squeak past on the thin boundary", () => {
    expect(hasMeaningfulChange(tradingStatus(asset(), price(10_071)).status, price(10_071))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(9_979)).status, price(9_979))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(99_999)).status, price(99_999))).toBe(false);
  });

  /**
   * Depth was not enough on its own. Amazon cleared the bar at $111k and still reported -68% for
   * the day; Strategy did the same at $110k. Ten thousand dollars past the line is still a book
   * one trade can write, and a competitor's table prints exactly these beside the real ones.
   */
  it("refuses a move the depth behind it could not have produced", () => {
    expect(hasMeaningfulChange(tradingStatus(asset(), price(111_000)).status, price(111_000, null, -67.81))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(110_000)).status, price(110_000, null, -72.45))).toBe(false);
    // The same market on an ordinary day keeps its move.
    expect(hasMeaningfulChange(tradingStatus(asset(), price(111_000)).status, price(111_000, null, -1.96))).toBe(true);
  });

  it("trusts a large move once the book is deep enough to mean it", () => {
    expect(hasMeaningfulChange(tradingStatus(asset(), price(2_400_000)).status, price(2_400_000, null, -41))).toBe(true);
    // Just under the deep line, the same move is the pool talking rather than the stock.
    expect(hasMeaningfulChange(tradingStatus(asset(), price(999_999)).status, price(999_999, null, -41))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(999_999)).status, price(999_999, null, -25))).toBe(true);
  });

  it("says nothing when the feed reports no move at all", () => {
    expect(hasMeaningfulChange(tradingStatus(asset(), price(2_400_000)).status, price(2_400_000, null, null))).toBe(false);
    expect(hasMeaningfulChange(tradingStatus(asset(), price(2_400_000)).status, null)).toBe(false);
  });

  it("orders deepest first and keeps input order within a tier", () => {
    const rows = [
      { name: "SNDK", asset: asset(), price: price(108) },
      { name: "COIN", asset: asset({ totalSupply: "0" }), price: price(0) },
      { name: "NVDA", asset: asset(), price: price(2_100_000) },
      { name: "SPCX", asset: asset(), price: price(27_905) },
      { name: "AAPL", asset: asset(), price: price(1_110_370) },
      { name: "HALT", asset: asset({ status: "paused" }), price: price(500_000) },
    ];
    expect(sortByTradingStatus(rows, (r) => r).map((r) => r.name)).toEqual(["NVDA", "AAPL", "SPCX", "SNDK", "COIN", "HALT"]);
  });
});

/**
 * A rebalance queues several legs and the user signs the plan, not each fill, so a leg that cannot
 * run has to be caught before anything is signed. The old check was `totalSupply > 0`, which let
 * through a stock that is issued with no pool, and one whose pool is smaller than the leg.
 */
describe("whether a buy leg can run", () => {
  it("refuses what cannot be filled at any size", () => {
    expect(buyLegBlockedReason("not-issued", 100, 0)).toMatch(/not issued/);
    expect(buyLegBlockedReason("no-pool", 100, 0)).toMatch(/no pool/);
    expect(buyLegBlockedReason("paused", 100, 5_000_000)).toMatch(/paused/);
  });

  it("refuses a leg that would eat its own pool", () => {
    // $20 into SanDisk's $108 pool: the trade is the market.
    expect(buyLegBlockedReason("very-thin", 20, 108)).toMatch(/% of its pool/);
    expect(buyLegBlockedReason("thin", 500, 10_000)).toMatch(/% of its pool/);
  });

  it("lets a leg through when the pool can absorb it", () => {
    expect(buyLegBlockedReason("tradable", 500, 2_100_000)).toBeNull();
    expect(buyLegBlockedReason("thin", 100, 27_905)).toBeNull();
    expect(buyLegBlockedReason("very-thin", 50, 9_979)).toBeNull(); // 0.5% of the pool
  });

  it("holds the two-percent line exactly", () => {
    expect(buyLegBlockedReason("tradable", 200, 10_000)).toBeNull(); // exactly 2%
    expect(buyLegBlockedReason("tradable", 201, 10_000)).toMatch(/% of its pool/);
  });

  it("measures the share, and reports none when there is no pool to measure", () => {
    expect(legPoolShare(500, 10_000)).toBeCloseTo(0.05);
    expect(legPoolShare(500, 0)).toBeNull();
    expect(legPoolShare(500, null)).toBeNull();
    expect(legPoolShare(0, 10_000)).toBeNull();
  });
});

describe("the gap between the pool and the reference", () => {
  const view = (deviationPct: number | null, extra: { referenceStale?: boolean; referencePaused?: boolean; referenceUsd?: number | null } = {}) => ({ deviationPct, referenceUsd: 500, referenceStale: false, referencePaused: false, ...extra });

  it("names a premium or a discount once it is worth naming", () => {
    expect(referenceGapNote(view(40.4))).toBe("pool price 40% above its Chainlink reference ($500.00)");
    expect(referenceGapNote(view(-12))).toBe("pool price 12% below its Chainlink reference ($500.00)");
    expect(referenceGapNote(view(3))).toBeNull();
    expect(referenceGap(view(3))).toEqual({ pct: 3, referenceUsd: 500 });
  });

  it("says nothing on a reference it cannot trust", () => {
    expect(referenceGapNote(view(40, { referenceStale: true }))).toBeNull();
    expect(referenceGapNote(view(40, { referencePaused: true }))).toBeNull();
    expect(referenceGapNote(view(40, { referenceUsd: null }))).toBeNull();
    expect(referenceGapNote(view(null))).toBeNull();
    expect(referenceGapNote(null)).toBeNull();
  });

  /** The contract fills no worse than reference minus the slippage limit; a premium past it is a skip. */
  it("knows when an automatic run would refuse the leg", () => {
    expect(premiumBeyondFloor(view(40), 300)).toBe(true);
    expect(premiumBeyondFloor(view(3.5), 300)).toBe(true);
    expect(premiumBeyondFloor(view(2.5), 300)).toBe(false);
    expect(premiumBeyondFloor(view(-40), 300)).toBe(false);
    expect(premiumBeyondFloor(view(40, { referenceStale: true }), 300)).toBe(false);
    expect(premiumBeyondFloor(null, 300)).toBe(false);
  });
});

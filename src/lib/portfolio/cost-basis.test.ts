import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import type { TradeRecord } from "@/db/repositories";
import { computeCostBasis, holdingPnl } from "./cost-basis";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const OWNER = "0x78de409a6306550882328E2a67160471368387FF" as Address;

/** 8-decimal raw units, the shape B20 balances actually come in. */
const units = (whole: number) => BigInt(Math.round(whole * 1e8)).toString();

let seq = 0;
function trade(over: Partial<TradeRecord> & { side: "buy" | "sell"; usdValue: number | null }): TradeRecord {
  seq += 1;
  return {
    id: `t${seq}`,
    owner: OWNER,
    assetAddress: NVDA,
    sellAmount: "0",
    buyAmount: "0",
    provider: "kyber",
    txHash: `0x${seq.toString(16).padStart(64, "0")}` as Hash,
    status: "confirmed",
    createdAt: seq * 1000,
    ...over,
  } as TradeRecord;
}

const buy = (whole: number, usd: number, over: Partial<TradeRecord> = {}) => trade({ side: "buy", buyAmount: units(whole), sellAmount: String(usd * 1e6), usdValue: usd, ...over });
const sell = (whole: number, usd: number, over: Partial<TradeRecord> = {}) => trade({ side: "sell", sellAmount: units(whole), buyAmount: String(usd * 1e6), usdValue: usd, ...over });

describe("cost basis", () => {
  it("averages several buys of the same stock", () => {
    const b = computeCostBasis([buy(1, 100), buy(1, 300)]).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(BigInt(units(2)));
    expect(b.costUsd).toBe(400); // $200 average
    expect(b.buys).toBe(2);
    expect(b.realisedUsd).toBe(0);
  });

  it("realises a gain at the average, not at the first lot", () => {
    // Bought 1 at $100 and 1 at $300 — average $200. Selling one at $250 realises $50, not $150.
    const b = computeCostBasis([buy(1, 100), buy(1, 300), sell(1, 250)]).get(NVDA.toLowerCase())!;
    expect(b.realisedUsd).toBeCloseTo(50);
    expect(b.coveredRaw).toBe(BigInt(units(1)));
    expect(b.costUsd).toBeCloseTo(200); // the remaining unit keeps the average
  });

  it("realises a loss the same way", () => {
    const b = computeCostBasis([buy(2, 400), sell(1, 150)]).get(NVDA.toLowerCase())!;
    expect(b.realisedUsd).toBeCloseTo(-50);
    expect(b.costUsd).toBeCloseTo(200);
  });

  it("leaves nothing behind when the whole position is sold", () => {
    const b = computeCostBasis([buy(2, 400), sell(2, 500)]).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(0n);
    expect(b.costUsd).toBe(0);
    expect(b.realisedUsd).toBeCloseTo(100);
  });

  /** Selling more than this app ever saw bought: the extra units have no basis to realise against. */
  it("does not invent a gain on units it never saw bought", () => {
    const b = computeCostBasis([buy(1, 100), sell(3, 600)]).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(0n);
    // Only the one covered unit realises: a third of $600 in, minus its $100 basis.
    expect(b.realisedUsd).toBeCloseTo(100);
  });

  it("ignores a sell with no prior buy rather than reporting free money", () => {
    const b = computeCostBasis([sell(1, 250)]).get(NVDA.toLowerCase())!;
    expect(b.realisedUsd).toBe(0);
    expect(b.sells).toBe(1);
  });

  it("counts a trade with no recorded USD instead of guessing at it", () => {
    const b = computeCostBasis([buy(1, 100), trade({ side: "buy", buyAmount: units(5), usdValue: null })]).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(BigInt(units(1))); // the unpriced five are not folded in
    expect(b.costUsd).toBe(100);
    expect(b.unpricedTrades).toBe(1);
  });

  it("keeps assets apart", () => {
    const m = computeCostBasis([buy(1, 100), buy(2, 500, { assetAddress: AAPL })]);
    expect(m.get(NVDA.toLowerCase())!.costUsd).toBe(100);
    expect(m.get(AAPL.toLowerCase())!.costUsd).toBe(500);
  });

  it("skips what never reached the chain", () => {
    const m = computeCostBasis([
      trade({ side: "buy", buyAmount: units(9), usdValue: 900, txHash: undefined }),
      trade({ side: "buy", buyAmount: units(9), usdValue: 900, status: "failed" }),
      buy(1, 100),
    ]);
    expect(m.get(NVDA.toLowerCase())!.costUsd).toBe(100);
  });

  it("replays in time order however the rows arrive", () => {
    const early = buy(1, 100);
    const late = sell(1, 250);
    const forwards = computeCostBasis([early, late]).get(NVDA.toLowerCase())!;
    const backwards = computeCostBasis([late, early]).get(NVDA.toLowerCase())!;
    expect(backwards.realisedUsd).toBeCloseTo(forwards.realisedUsd);
    expect(backwards.coveredRaw).toBe(forwards.coveredRaw);
  });
});

describe("holding profit and loss", () => {
  const basis = () => computeCostBasis([buy(2, 400)]).get(NVDA.toLowerCase());

  it("values only the units it has a price behind", () => {
    // Holds 5, bought 2 here at $200 each, market $250.
    const p = holdingPnl(NVDA, BigInt(units(5)), 8, 250, basis());
    expect(p.coveredRaw).toBe(BigInt(units(2)));
    expect(p.uncoveredRaw).toBe(BigInt(units(3)));
    expect(p.costUsd).toBeCloseTo(400);
    expect(p.marketUsd).toBeCloseTo(500);
    expect(p.unrealisedUsd).toBeCloseTo(100);
    expect(p.unrealisedPct).toBeCloseTo(25);
  });

  /** A gift or a pool share is held, not bought — it must not read as pure profit. */
  it("reports a gifted holding as uncovered rather than as a 100% gain", () => {
    const p = holdingPnl(NVDA, BigInt(units(3)), 8, 250, undefined);
    expect(p.coveredRaw).toBe(0n);
    expect(p.uncoveredRaw).toBe(BigInt(units(3)));
    expect(p.costUsd).toBe(0);
    expect(p.unrealisedUsd).toBe(0);
    expect(p.unrealisedPct).toBeNull();
  });

  /** Stock sent away or sold elsewhere leaves the ledger ahead of the wallet. */
  it("never claims more covered units than are actually held", () => {
    const p = holdingPnl(NVDA, BigInt(units(1)), 8, 250, basis());
    expect(p.coveredRaw).toBe(BigInt(units(1)));
    expect(p.uncoveredRaw).toBe(0n);
    expect(p.costUsd).toBeCloseTo(200); // half the basis follows the half that is left
    expect(p.unrealisedUsd).toBeCloseTo(50);
  });

  it("says nothing about profit when the stock has no price", () => {
    const p = holdingPnl(NVDA, BigInt(units(2)), 8, null, basis());
    expect(p.marketUsd).toBe(0);
    expect(p.unrealisedUsd).toBe(0);
    expect(p.unrealisedPct).toBeNull();
    expect(p.costUsd).toBeCloseTo(400); // what was paid is still known
  });
});

describe("cost basis: whose units, and how many times", () => {
  const RECIPIENT = "0x000000000000000000000000000000000000bEEF" as Address;

  /** The same gift, seen from the holding: the buyer's wallet never received those units, so nothing is covered by them. */
  it("values a holding without the units bought for someone else", () => {
    const basis = computeCostBasis([buy(1, 100), buy(1, 300, { recipient: RECIPIENT })]).get(NVDA.toLowerCase());
    // The buyer holds only the one unit that landed in their own wallet.
    const mine = holdingPnl(NVDA, BigInt(units(1)), 8, 250, basis);
    expect(mine.coveredRaw).toBe(BigInt(units(1)));
    expect(mine.costUsd).toBeCloseTo(100);
    expect(mine.unrealisedUsd).toBeCloseTo(150);
    // The recipient holds the gifted unit with no purchase of their own behind it.
    const theirs = holdingPnl(NVDA, BigInt(units(1)), 8, 250, computeCostBasis([]).get(NVDA.toLowerCase()));
    expect(theirs.coveredRaw).toBe(0n);
    expect(theirs.uncoveredRaw).toBe(BigInt(units(1)));
    expect(theirs.unrealisedPct).toBeNull();
  });

  it("keeps a gift bought for someone else out of the buyer's position", () => {
    // Bought 1 for the wallet at $100, then 1 for a friend at $300 (filed under the buyer, delivered to the friend).
    const b = computeCostBasis([buy(1, 100), buy(1, 300, { recipient: RECIPIENT })]).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(BigInt(units(1)));
    expect(b.costUsd).toBe(100);
    expect(b.buys).toBe(1);
  });

  it("treats a buy delivered to the buyer's own wallet as its own", () => {
    const b = computeCostBasis([buy(1, 100, { recipient: OWNER })]).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(BigInt(units(1)));
    expect(b.costUsd).toBe(100);
  });

  it("counts one transaction, one stock, one side once, however many rows say it", () => {
    const hash = `0x${"ab".repeat(32)}` as Hash;
    const twice = [buy(1, 100, { txHash: hash }), buy(1, 100, { txHash: hash })];
    const b = computeCostBasis(twice).get(NVDA.toLowerCase())!;
    expect(b.coveredRaw).toBe(BigInt(units(1)));
    expect(b.costUsd).toBe(100);
    expect(b.buys).toBe(1);
    // A different stock in the same transaction (a basket) is a different trade.
    const basket = [buy(1, 100, { txHash: hash }), buy(1, 50, { txHash: hash, assetAddress: AAPL })];
    expect(computeCostBasis(basket).size).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { TradeRecord } from "@/db/repositories";
import { WAD, toScaled, equityPricePerShare, rawValueUsd } from "@/lib/b20/math";
import { computeCostBasis, holdingPnl } from "./cost-basis";
import { equalWeightIndex } from "@/services/portfolio-curve-service";

/**
 * A 2-for-1 split, simulated through every place the app prices a stock, and through the
 * AutoInvest contract's own floor formula.
 *
 * The facts this rests on, from Base's tokenized-stock documentation: the B20 multiplier turns
 * raw units into share-equivalents (`scaled = raw × multiplier / 1e18`); a split changes the
 * multiplier, never anyone's raw balance; and the Chainlink feed is **total return** — it
 * publishes `underlying price × multiplier`, so "the multiplier and underlying price move in
 * opposite directions and cancel (a 10:1 split drops the price ~10x and raises the multiplier
 * ~10x)". The feed freezes during the action and resumes only once both have moved.
 *
 * So one raw token is worth the same the day after a split as the day before, and every figure
 * that is built on raw units × feed price must not move. The share-equivalent view doubles and
 * the per-share price halves, and that is display.
 */
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const ME = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const DECIMALS = 8;
const ONE_TOKEN = 10n ** BigInt(DECIMALS);

/** Before: multiplier 1×, one share per token, the underlying at $150. After a 2:1 split: two shares per token at $75. */
const before = { multiplier: WAD, sharePriceUsd: 150, feedPerTokenUsd: 150 };
const after = { multiplier: 2n * WAD, sharePriceUsd: 75, feedPerTokenUsd: 75 * 2 };

describe("a 2-for-1 split, through the app's arithmetic", () => {
  const raw = 3n * ONE_TOKEN; // three raw tokens

  it("changes the share-equivalent view and nothing about the raw balance", () => {
    expect(toScaled(raw, before.multiplier)).toBe(3n * ONE_TOKEN);
    expect(toScaled(raw, after.multiplier)).toBe(6n * ONE_TOKEN);
  });

  it("keeps the token's value and halves the per-share price", () => {
    expect(rawValueUsd(raw, DECIMALS, before.feedPerTokenUsd)).toBeCloseTo(450, 8);
    expect(rawValueUsd(raw, DECIMALS, after.feedPerTokenUsd)).toBeCloseTo(450, 8);
    expect(equityPricePerShare(before.feedPerTokenUsd, before.multiplier)).toBeCloseTo(150, 8);
    expect(equityPricePerShare(after.feedPerTokenUsd, after.multiplier)).toBeCloseTo(75, 8);
  });

  /** The cost basis is kept in raw units, so a split neither creates nor destroys a gain. */
  it("leaves the cost basis and the profit or loss where they were", () => {
    const trades: TradeRecord[] = [{ id: "t1", owner: ME, side: "buy", assetAddress: NVDA, sellAmount: "450000000", buyAmount: raw.toString(), usdValue: 450, provider: "kyber", txHash: `0x${"11".repeat(32)}`, status: "confirmed", createdAt: 1, verifiedAt: 2 }];
    const basis = computeCostBasis(trades).get(NVDA.toLowerCase());
    const pnlBefore = holdingPnl(NVDA, raw, DECIMALS, before.feedPerTokenUsd, basis);
    const pnlAfter = holdingPnl(NVDA, raw, DECIMALS, after.feedPerTokenUsd, basis);
    expect(pnlBefore.costUsd).toBeCloseTo(450, 8);
    expect(pnlAfter.costUsd).toBeCloseTo(450, 8);
    expect(pnlBefore.unrealisedUsd).toBeCloseTo(0, 8);
    expect(pnlAfter.unrealisedUsd).toBeCloseTo(0, 8);
    expect(pnlAfter.coveredRaw).toBe(raw);
  });

  /** The value curve is raw units × feed history: a total-return feed shows no step on split day. */
  it("draws a continuous value curve across the split day", () => {
    const feedHistory = [before.feedPerTokenUsd, before.feedPerTokenUsd, after.feedPerTokenUsd, after.feedPerTokenUsd];
    const values = feedHistory.map((p) => rawValueUsd(raw, DECIMALS, p));
    expect(new Set(values.map((v) => v.toFixed(6))).size).toBe(1);
    const idx = equalWeightIndex([feedHistory], feedHistory.length);
    expect(idx!.points.every((p) => p !== null && Math.abs(p - 1) < 1e-12)).toBe(true);
  });
});

/**
 * The contract's reference floor, `AutoInvest.quoteFloor`, transcribed:
 *
 *   expected = amountIn × 10^feedDecimals × 10^assetDecimals × WAD / (USDC_UNIT × answer × multiplier)
 *
 * with the comment "the feed prices one share; the B20 multiplier turns shares into raw units".
 * Against a total-return feed that assumption is one multiplier too many: the feed already
 * prices a raw token, so dividing by the multiplier again makes the floor `multiplier` times
 * looser after a split. Looser, never tighter — a split can never make the contract refuse a
 * fair swap — but the protection it gives shrinks from "the reference less slippage" to half
 * that after a 2:1 split. Today every multiplier is 1× and the floor is exact.
 */
function quoteFloorRaw(amountInUsdc: bigint, feedAnswer: bigint, multiplier: bigint): bigint {
  const FEED_DECIMALS = 8n;
  const USDC_UNIT = 10n ** 6n;
  return (amountInUsdc * 10n ** FEED_DECIMALS * 10n ** BigInt(DECIMALS) * WAD) / (USDC_UNIT * feedAnswer * multiplier);
}

describe("a 2-for-1 split, through AutoInvest's reference floor", () => {
  const amountIn = 450n * 10n ** 6n; // $450
  const fair = 3n * ONE_TOKEN; // what $450 buys at $150 a token, before and after

  it("is exact while the multiplier is 1×", () => {
    expect(quoteFloorRaw(amountIn, 150n * 10n ** 8n, before.multiplier)).toBe(fair);
  });

  it("is loose by the multiplier after the split, never tight", () => {
    const floor = quoteFloorRaw(amountIn, BigInt(after.feedPerTokenUsd) * 10n ** 8n, after.multiplier);
    expect(floor).toBe(fair / 2n);
    expect(floor).toBeLessThan(fair);
  });

  it("would be exact only if the feed priced one share, which the documentation says it does not", () => {
    const perShareAnswer = BigInt(after.sharePriceUsd) * 10n ** 8n;
    expect(quoteFloorRaw(amountIn, perShareAnswer, after.multiplier)).toBe(fair);
  });
});

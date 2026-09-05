import { describe, expect, it } from "vitest";
import { sharesForUsd } from "./index";

const WAD = "1000000000000000000";

describe("typing a pool amount in dollars", () => {
  /** A stock that has never split: share units and raw units are the same thing. */
  it("converts at the quoted price", () => {
    // Against the arithmetic rather than a hand-rounded constant, which only tests the rounding.
    expect(Number(sharesForUsd("100", 230.22, WAD, WAD, 8))).toBeCloseTo(100 / 230.22, 7);
    expect(Number(sharesForUsd(10, 320.09, WAD, WAD, 8))).toBeCloseTo(10 / 320.09, 7);
    expect(Number(sharesForUsd("1000", 1, WAD, WAD, 8))).toBe(1000);
  });

  /**
   * The price quotes the raw token while the creator types share units, so a stock that has split
   * two-for-one buys twice as many raw units per share and the figure has to account for it.
   */
  it("undoes the multiplier for a stock that has split", () => {
    const twoForOne = "2000000000000000000";
    const plain = Number(sharesForUsd("100", 50, WAD, WAD, 8));
    const split = Number(sharesForUsd("100", 50, twoForOne, WAD, 8));
    expect(plain).toBeCloseTo(2, 6);
    expect(split).toBeCloseTo(1, 6);
  });

  it("answers nothing rather than zero when it cannot know", () => {
    expect(sharesForUsd("100", null, WAD, WAD, 8)).toBe("");
    expect(sharesForUsd("100", 0, WAD, WAD, 8)).toBe("");
    expect(sharesForUsd("", 230, WAD, WAD, 8)).toBe("");
    expect(sharesForUsd("abc", 230, WAD, WAD, 8)).toBe("");
    expect(sharesForUsd("-5", 230, WAD, WAD, 8)).toBe("");
    expect(sharesForUsd("0", 230, WAD, WAD, 8)).toBe("");
  });

  /** A dust amount at a four-figure price rounds to nothing, and says so instead of "0.00000000". */
  it("returns nothing when the dollars do not reach one unit of precision", () => {
    expect(sharesForUsd("0.0000001", 2214.95, WAD, WAD, 8)).toBe("");
  });

  it("never emits a trailing dot or trailing zeros", () => {
    for (const usd of ["1", "10", "100", "1000", "12.34"]) {
      const out = sharesForUsd(usd, 230.22, WAD, WAD, 8);
      expect(out).not.toMatch(/\.$/);
      expect(out).not.toMatch(/\.\d*0$/);
      expect(Number(out)).toBeGreaterThan(0);
    }
  });

  it("respects the token's own precision", () => {
    expect(sharesForUsd("100", 230.22, WAD, WAD, 2).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });
});

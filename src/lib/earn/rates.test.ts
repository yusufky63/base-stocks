import { describe, expect, it } from "vitest";
import { aprToApyPct, perSecondRateToAprPct, perSecondRateToApyPct, SECONDS_PER_YEAR } from "./rates";

describe("Aave: linear APR to compounded APY", () => {
  it("compounds daily, which lifts a 5% APR to about 5.13%", () => {
    expect(aprToApyPct(5)).toBeCloseTo(5.1267, 3);
  });
  it("is the identity at zero and never negative", () => {
    expect(aprToApyPct(0)).toBe(0);
    expect(aprToApyPct(-2)).toBe(0);
    expect(aprToApyPct(Number.NaN)).toBe(0);
  });
  it("always reads above the APR it came from", () => {
    for (const apr of [0.5, 3, 12, 40]) expect(aprToApyPct(apr)).toBeGreaterThan(apr);
  });
});

describe("Compound: per-second rate to APY", () => {
  // getSupplyRate returns a per-second rate scaled by 1e18; 4.4% APR is about 1.395e-9 per second.
  const r = 0.044 / SECONDS_PER_YEAR;
  it("recovers the linear APR", () => {
    expect(perSecondRateToAprPct(r)).toBeCloseTo(4.4, 6);
  });
  it("compounds every second to just under e^APR", () => {
    const apy = perSecondRateToApyPct(r);
    expect(apy).toBeGreaterThan(4.4);
    expect(apy).toBeCloseTo((Math.exp(0.044) - 1) * 100, 4);
  });
  it("does not lose a tiny rate to double precision", () => {
    // 1 + 1e-12 is representable only to ~2e-16; log1p keeps the rate itself, so the result is
    // the linear figure plus the (tiny) compounding, not a number dominated by rounding noise.
    const linear = 1e-12 * SECONDS_PER_YEAR * 100;
    const apy = perSecondRateToApyPct(1e-12);
    expect(apy).toBeGreaterThan(linear);
    expect(apy).toBeCloseTo(linear, 6);
  });
  it("is zero for nothing", () => {
    expect(perSecondRateToApyPct(0)).toBe(0);
    expect(perSecondRateToApyPct(-1)).toBe(0);
  });
});

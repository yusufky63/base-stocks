import { describe, expect, it } from "vitest";
import { USD_TOLERANCE, boundedUsd } from "./record-usd";

/** The edges of the band `record-usd.test.ts` covers from the middle. */
describe("boundedUsd at the edges of the band", () => {
  it("is ±25% of the receipt's worth", () => {
    expect(USD_TOLERANCE).toBe(0.25);
  });

  it("keeps a figure exactly on either edge and replaces one just past it", () => {
    expect(boundedUsd(31.25, 25)).toBe(31.25);
    expect(boundedUsd(18.75, 25)).toBe(18.75);
    expect(boundedUsd(31.26, 25)).toBe(25);
    expect(boundedUsd(18.74, 25)).toBe(25);
  });

  it("rounds the replacement to cents but leaves a kept figure as sent", () => {
    expect(boundedUsd(1_000, 33.3333)).toBe(33.33);
    expect(boundedUsd(33.3349, 33.3333)).toBe(33.3349);
  });

  it("treats a negative or infinite browser figure as absent", () => {
    expect(boundedUsd(-40, 25)).toBe(25);
    expect(boundedUsd(Number.POSITIVE_INFINITY, 25)).toBe(25);
    expect(boundedUsd(undefined, 25)).toBe(25);
  });

  it("has no ceiling when the estimate is not a usable price", () => {
    expect(boundedUsd(40, -25)).toBe(40);
    expect(boundedUsd(40, Number.POSITIVE_INFINITY)).toBe(40);
    expect(boundedUsd(40, Number.NaN)).toBe(40);
    expect(boundedUsd(-40, Number.NaN)).toBeNull();
  });
});

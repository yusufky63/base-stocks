import { describe, expect, it } from "vitest";
import { boundedUsd } from "./record-usd";

describe("boundedUsd", () => {
  it("keeps an honest browser figure", () => {
    expect(boundedUsd(24.8, 25)).toBe(24.8);
    expect(boundedUsd(30, 25)).toBe(30); // +20%: inside the band
  });

  it("replaces a figure outside the band with the receipt's own worth", () => {
    expect(boundedUsd(1_000_000, 25)).toBe(25);
    expect(boundedUsd(1, 25)).toBe(25);
  });

  it("falls back to the estimate when the browser sent nothing usable", () => {
    expect(boundedUsd(null, 25.129)).toBe(25.13);
    expect(boundedUsd(0, 25)).toBe(25);
    expect(boundedUsd(Number.NaN, 25)).toBe(25);
  });

  it("has no ceiling without a price, and nothing at all without either", () => {
    expect(boundedUsd(17, null)).toBe(17);
    expect(boundedUsd(null, null)).toBeNull();
    expect(boundedUsd(17, 0)).toBe(17);
  });
});

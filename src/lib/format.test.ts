import { afterEach, describe, expect, it, vi } from "vitest";
import { bpsToPct, formatPct, formatTokenAmount, formatUsd, formatUsdCompact, shortenAddress, timeAgo } from "./format";

describe("format helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("formats dollars, with a dash for what is not a number", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-12.345)).toBe("-$12.35");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("—");
  });

  /** Sub-dollar prices (a pool quoting a token in cents) keep four decimals only when asked. */
  it("keeps four decimals under a dollar only in precise mode", () => {
    expect(formatUsd(0.1234, { precise: true })).toBe("$0.1234");
    expect(formatUsd(0.1234)).toBe("$0.12");
    expect(formatUsd(12.3456, { precise: true })).toBe("$12.35");
  });

  it("compacts large figures and leaves small ones exact", () => {
    expect(formatUsdCompact(999)).toBe("$999.00");
    expect(formatUsdCompact(2_100_000)).toBe("$2.1M");
    expect(formatUsdCompact(27_905)).toBe("$27.9K");
    expect(formatUsdCompact(null)).toBe("—");
  });

  it("signs percentages and honours the digit count", () => {
    expect(formatPct(1.234)).toBe("+1.23%");
    expect(formatPct(-1.234)).toBe("-1.23%");
    expect(formatPct(0)).toBe("0.00%");
    expect(formatPct(5, { sign: false, digits: 0 })).toBe("5%");
    expect(formatPct(null)).toBe("—");
  });

  /** Base units in, a human amount out; the fraction digits follow the size so dust is not hidden as "0". */
  it("formats token amounts from base units", () => {
    expect(formatTokenAmount(123_456_789n, 8)).toBe("1.2346");
    expect(formatTokenAmount("123456789", 8)).toBe("1.2346");
    expect(formatTokenAmount(0n, 8)).toBe("0");
    expect(formatTokenAmount(50_000n, 8)).toBe("0.0005");
    expect(formatTokenAmount(5n, 8)).toBe("0.00000005");
    expect(formatTokenAmount(null, 8)).toBe("—");
    expect(formatTokenAmount(123_456_789n, 8, 2)).toBe("1.23");
  });

  it("shortens addresses", () => {
    expect(shortenAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortenAddress("0x1234567890abcdef1234567890abcdef12345678", 6)).toBe("0x123456…345678");
    expect(shortenAddress("")).toBe("");
  });

  /** Seconds and milliseconds are both accepted; the boundary is a plausible epoch in ms (1e12 ≈ 2001). */
  it("says how long ago, in seconds or milliseconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
    const now = Date.now();
    expect(timeAgo(now - 30_000)).toBe("30s ago");
    expect(timeAgo(now - 5 * 60_000)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3600_000)).toBe("3h ago");
    expect(timeAgo(now - 47 * 3600_000)).toBe("47h ago");
    expect(timeAgo(now - 72 * 3600_000)).toBe("3d ago");
    expect(timeAgo(Math.floor(now / 1000) - 90)).toBe("1m ago");
    expect(timeAgo(now + 60_000)).toBe("0s ago");
    expect(timeAgo(null)).toBe("—");
    expect(timeAgo(0)).toBe("—");
  });

  it("prints basis points as percent with a decimal only when needed", () => {
    expect(bpsToPct(2_500)).toBe("25%");
    expect(bpsToPct(1_250)).toBe("12.5%");
    expect(bpsToPct(0)).toBe("0%");
    expect(bpsToPct(10_000)).toBe("100%");
  });
});

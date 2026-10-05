import { beforeEach, describe, expect, it, vi } from "vitest";
import type { B20Asset } from "@/domain/asset";

const h = vi.hoisted(() => ({ quote: vi.fn() }));
vi.mock("@/providers/market-data/equity/yahoo", () => ({ getYahooQuote: h.quote }));
vi.mock("@/lib/shared-store", () => ({ getSharedStore: () => null }));

import { invalidate } from "@/lib/cache";
import { getEquityReferences, toEquityReference } from "./equity-reference-service";

const WAD = 10n ** 18n;
const asset = (id: number, over: Partial<B20Asset> = {}) => ({ address: `0x${String(id).padStart(40, "0")}`, canonicalId: `0x${String(id).padStart(40, "0")}`, underlying: `T${id}`, status: "active", totalSupply: 100n, multiplier: WAD, wadPrecision: WAD, ...over }) as B20Asset;
const quote = (priceUsd: number, updatedAt: number) => ({ symbol: "X", priceUsd, updatedAt, points: [{ time: 1, price: priceUsd }] });

// Wednesday 2026-10-07 11:00 New York, a regular session.
const SESSION = Date.UTC(2026, 9, 7, 15, 0);
// Saturday 2026-10-10 noon UTC, the day after Friday's 16:00 New York close.
const SATURDAY = Date.UTC(2026, 9, 10, 12, 0);
const FRIDAY_CLOSE = Date.UTC(2026, 9, 9, 20, 0);

describe("toEquityReference", () => {
  it("prices one token as the share price times the multiplier, the series too", () => {
    const ref = toEquityReference({ multiplier: 2n * WAD, wadPrecision: WAD }, quote(100, SESSION - 60_000), SESSION);
    expect(ref?.priceUsd).toBe(200);
    expect(ref?.sharePriceUsd).toBe(100);
    expect(ref?.points).toEqual([{ time: 1, price: 200 }]);
  });

  it("is live during a session, the last close on a weekend, stale when a session was missed", () => {
    expect(toEquityReference(asset(1), quote(10, SESSION - 5 * 60_000), SESSION)?.freshness).toBe("live");
    expect(toEquityReference(asset(1), quote(10, FRIDAY_CLOSE), SATURDAY)?.freshness).toBe("last-close");
    expect(toEquityReference(asset(1), quote(10, SESSION - 10 * 86_400_000), SESSION)?.freshness).toBe("stale");
  });

  it("gives no reference for a multiplier it cannot read", () => {
    expect(toEquityReference({ multiplier: 0n, wadPrecision: WAD }, quote(10, SESSION), SESSION)).toBeNull();
  });
});

describe("getEquityReferences", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await invalidate("");
  });

  it("asks only for issued, active stocks without a Chainlink feed", async () => {
    h.quote.mockImplementation(async () => quote(10, Date.now()));
    const assets = [asset(1), asset(2, { oracle: { feed: "0x00000000000000000000000000000000000000fe" } as unknown as B20Asset["oracle"] }), asset(3, { totalSupply: 0n }), asset(4, { status: "paused" as B20Asset["status"] })];
    const refs = await getEquityReferences(assets);
    expect([...refs.keys()]).toEqual([asset(1).canonicalId]);
    expect(h.quote).toHaveBeenCalledTimes(1);
    expect(h.quote).toHaveBeenCalledWith("T1");
  });

  it("leaves out a stock Yahoo cannot answer for, and keeps the rest", async () => {
    h.quote.mockImplementation(async (t: string) => (t === "T1" ? null : quote(10, Date.now())));
    const refs = await getEquityReferences([asset(1), asset(2)]);
    expect([...refs.keys()]).toEqual([asset(2).canonicalId]);
  });
});

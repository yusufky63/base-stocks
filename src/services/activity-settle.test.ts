import { describe, expect, it } from "vitest";
import { settleRecord } from "./activity-service";

describe("what became of a record the app wrote down", () => {
  /** Seeing the token move is the chain saying it happened; nothing else needs asking. */
  it("takes the transfer as proof on its own", () => {
    expect(settleRecord(true, undefined)).toEqual({ verified: true, failed: false });
    // Even a receipt that disagrees cannot unsay a transfer we watched land.
    expect(settleRecord(true, { status: "pending" })).toEqual({ verified: true, failed: false });
  });

  it("lets the receipt decide when no transfer was seen", () => {
    expect(settleRecord(false, { status: "success", blockNumber: 42 })).toEqual({ verified: true, failed: false, blockNumber: 42 });
    expect(settleRecord(false, { status: "reverted", blockNumber: 43 })).toEqual({ verified: false, failed: true, blockNumber: 43 });
  });

  /**
   * The bug this replaces: verification was a single boolean off a transfer scan that only reaches
   * back a couple of days on Base. A trade older than that could never be matched, so it sat on
   * "pending verification" for good — a warning badge with no way out of it.
   */
  it("is only pending while the transaction is genuinely not mined", () => {
    expect(settleRecord(false, { status: "pending" })).toEqual({ verified: false, failed: false, blockNumber: undefined });
    // An old trade the scan cannot reach still settles, because the receipt does not expire.
    expect(settleRecord(false, { status: "success", blockNumber: 1 }).verified).toBe(true);
  });

  it("stays pending rather than guessing when there is no answer at all", () => {
    const r = settleRecord(false, undefined);
    expect(r.verified).toBe(false);
    expect(r.failed).toBe(false);
  });

  it("never calls a record both confirmed and failed", () => {
    for (const status of ["success", "reverted", "pending"] as const) {
      for (const saw of [true, false]) {
        const r = settleRecord(saw, { status });
        expect(r.verified && r.failed).toBe(false);
      }
    }
  });
});

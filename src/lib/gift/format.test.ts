import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { GiftRecord } from "@/domain/gift";
import { formatShares, giftAmountLabel, giftPartyLabel, giftPartyName, giftStatusInfo, isBrandLikeName, scaledAmount, truncateMessage } from "./format";

const ADDR = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const WAD = "1000000000000000000";

const gift = (over: Partial<GiftRecord> = {}): GiftRecord => ({
  id: "gift_x",
  kind: "send-existing",
  sender: ADDR,
  recipient: ADDR,
  assetAddress: ADDR,
  rawAmount: "100000000",
  memo: "0x00",
  status: "submitted",
  createdAt: 0,
  ...over,
});

describe("gift amounts", () => {
  it("applies the B20 multiplier: raw × multiplier / WAD", () => {
    // A 2:1 split doubled the multiplier; 1 raw share is now 2 share-equivalents.
    expect(scaledAmount("100000000", "2000000000000000000", WAD)).toBe(200000000n);
    expect(scaledAmount(5n, WAD, WAD)).toBe(5n);
  });

  it("formats in share units with the asset's decimals, the way the receipt does", () => {
    expect(formatShares("50000000", { multiplier: WAD, wadPrecision: WAD, decimals: 8 })).toBe("0.5");
    expect(formatShares("50000000", { multiplier: "2000000000000000000", wadPrecision: WAD, decimals: 8 })).toBe("1");
  });

  it("labels a receipt by share-equivalents and ticker, and degrades without an asset", () => {
    const asset = { multiplier: WAD, wadPrecision: WAD, decimals: 8, underlying: "NVDA" };
    expect(giftAmountLabel({ gift: gift(), asset: asset as never })).toBe("1 NVDA");
    expect(giftAmountLabel({ gift: gift(), asset: null })).toBe("stock");
  });
});

describe("party names", () => {
  it("refuses names that read like the brand or its support desk", () => {
    for (const n of ["Coinbase Support", "coin_base", "BaseStocks", "bstocks team", "Official", "admin", "Base", "the base team", "Support Desk"]) {
      expect(isBrandLikeName(n), n).toBe(true);
    }
    for (const n of ["Alice", "database guy", "Basel Fan", "Based Bob was here", null, undefined, ""]) {
      expect(isBrandLikeName(n), String(n)).toBe(false);
    }
  });

  it("labels by identity only: Basename, else the short address, never the display name", () => {
    expect(giftPartyLabel({ address: ADDR, basename: "alice.base.eth" })).toBe("alice.base.eth");
    expect(giftPartyLabel({ address: ADDR, basename: null })).toBe("0x78de…87FF");
  });

  it("never shows a display name without the identity beside it", () => {
    expect(giftPartyName({ address: ADDR, basename: "alice.base.eth", displayName: "Alice" })).toBe("Alice · alice.base.eth");
    expect(giftPartyName({ address: ADDR, basename: null, displayName: "Alice" })).toBe("Alice · 0x78de…87FF");
    expect(giftPartyName({ address: ADDR, basename: null, displayName: "Coinbase Support" })).toBe("0x78de…87FF");
    expect(giftPartyName({ address: ADDR, basename: "alice.base.eth", displayName: "alice.base.eth" })).toBe("alice.base.eth");
  });
});

describe("gift status", () => {
  const now = 1_000_000;
  it("puts failed and expired before 'awaiting claim' for a claim link", () => {
    expect(giftStatusInfo(gift({ kind: "claim-link", status: "failed", expiresAt: now + 1 }), now).key).toBe("failed");
    expect(giftStatusInfo(gift({ kind: "claim-link", status: "submitted", expiresAt: now - 1 }), now).key).toBe("expired");
    expect(giftStatusInfo(gift({ kind: "claim-link", status: "submitted", expiresAt: now + 1 }), now).key).toBe("awaiting");
  });
  it("reads terminal states first, whatever the kind", () => {
    expect(giftStatusInfo(gift({ kind: "claim-link", status: "claimed", expiresAt: now - 1 }), now).key).toBe("claimed");
    expect(giftStatusInfo(gift({ kind: "claim-link", status: "reclaimed" }), now).key).toBe("reclaimed");
    expect(giftStatusInfo(gift({ status: "confirmed" }), now)).toMatchObject({ key: "delivered", tone: "positive" });
    expect(giftStatusInfo(gift({ status: "submitted" }), now).key).toBe("submitted");
  });
});

describe("messages", () => {
  it("truncates by code point so an emoji is never split", () => {
    const msg = "🎁".repeat(45);
    const out = truncateMessage(msg, 40);
    expect(Array.from(out)).toHaveLength(41);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("🎁".repeat(40))).toBe(true);
    expect(truncateMessage("short", 40)).toBe("short");
  });
});

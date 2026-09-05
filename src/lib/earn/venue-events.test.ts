import { describe, expect, it } from "vitest";
import type { Address, Hash } from "viem";
import { decodeVenueEvent, earnRecordFromEvent, earnRecordId, type EarnVenue } from "./venue-events";

const A = "0xeaa823ab4c4ee00283d8ed7be713ddf8a5ba0fac" as Address;
const RELAYER = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const tx = `0x${"ab".repeat(32)}` as Hash;
const meta = { txHash: tx, blockNumber: 50_900_000n, logIndex: 7 };

describe("who a venue event belongs to", () => {
  /** A smart account or a relayer sends the transaction; the position belongs to the wallet named in the event. */
  it("credits the position owner, never the transaction sender", () => {
    expect(decodeVenueEvent("aave", "deposit", { reserve: USDC, user: RELAYER, onBehalfOf: A, amount: 7_500_000n, referralCode: 0 }, meta)).toMatchObject({ action: "deposit", wallet: A, amount: 7_500_000n });
    expect(decodeVenueEvent("aave", "withdraw", { reserve: USDC, user: A, to: RELAYER, amount: 1n }, meta)).toMatchObject({ action: "withdraw", wallet: A });
    expect(decodeVenueEvent("erc4626", "deposit", { sender: RELAYER, owner: A, assets: 10n, shares: 9n }, meta)).toMatchObject({ wallet: A, amount: 10n });
    expect(decodeVenueEvent("erc4626", "withdraw", { sender: RELAYER, receiver: RELAYER, owner: A, assets: 4n, shares: 3n }, meta)).toMatchObject({ wallet: A, amount: 4n });
    expect(decodeVenueEvent("comet", "deposit", { from: RELAYER, dst: A, amount: 5n }, meta)).toMatchObject({ wallet: A, amount: 5n });
    expect(decodeVenueEvent("comet", "withdraw", { src: A, to: RELAYER, amount: 6n }, meta)).toMatchObject({ wallet: A, amount: 6n });
  });

  it("ignores an event with nothing in it", () => {
    expect(decodeVenueEvent("aave", "deposit", { reserve: USDC, user: A, onBehalfOf: A, amount: 0n, referralCode: 0 }, meta)).toBeNull();
    expect(decodeVenueEvent("comet", "deposit", { from: A, amount: 5n }, meta)).toBeNull();
  });
});

describe("the record a venue event becomes", () => {
  const venue: EarnVenue = { kind: "aave", address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", provider: "aave", opportunityId: `aave:supply:${USDC.toLowerCase()}` };

  it("uses the browser's own id scheme so a late record never lands twice", () => {
    expect(earnRecordId(tx)).toBe(`earn_${"ab".repeat(8)}`);
    expect(earnRecordId(tx, 7)).toBe(`earn_${"ab".repeat(8)}_7`);
  });

  it("is dated by the block and valued at face value for USDC", () => {
    const ev = decodeVenueEvent("aave", "deposit", { reserve: USDC, user: A, onBehalfOf: A, amount: 7_575_340n, referralCode: 0 }, meta)!;
    const r = earnRecordFromEvent(venue, ev, 1_788_400_000, earnRecordId(tx));
    expect(r).toMatchObject({ owner: A, provider: "aave", action: "deposit", amount: "7575340", usdValue: 7.57534, txHash: tx, createdAt: 1_788_400_000_000 });
  });
});

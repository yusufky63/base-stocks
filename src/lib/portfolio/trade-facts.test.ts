import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, pad, type Address, type Hex } from "viem";
import { netFlow, tokenMoves, tradeFacts, type ReceiptLog } from "@/lib/chain/receipt-checks";

/**
 * The receipt checks the portfolio side leans on: a basket leg, a manual plan run and a trade row
 * all count only when `tradeFacts` says the stock reached the right wallet, and the USD they keep
 * is the USDC leg `tradeFacts` reads. These pin the edges that matter for those callers.
 */
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const ME = "0x1000000000000000000000000000000000000001" as Address;
const FRIEND = "0x2000000000000000000000000000000000000002" as Address;
const ROUTER = "0x3000000000000000000000000000000000000003" as Address;

let logIndex = 0;
function transfer(token: Address, from: Address, to: Address, value: bigint): ReceiptLog {
  const [topic0] = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" });
  return { address: token, topics: [topic0!, pad(from), pad(to)], data: encodeAbiParameters([{ type: "uint256" }], [value]) as Hex, logIndex: logIndex++ };
}
/** An `Approval` has the same topic count as a `Transfer`; it must not be read as one. */
function approval(token: Address, owner: Address, spender: Address, value: bigint): ReceiptLog {
  const [topic0] = encodeEventTopics({ abi: erc20Abi, eventName: "Approval" });
  return { address: token, topics: [topic0!, pad(owner), pad(spender)], data: encodeAbiParameters([{ type: "uint256" }], [value]) as Hex, logIndex: logIndex++ };
}

describe("netFlow", () => {
  it("nets what arrived against what left, for one token and one wallet, case-insensitively", () => {
    const moves = tokenMoves([transfer(AAPL, ROUTER, ME, 300n), transfer(AAPL, ME, FRIEND, 100n), transfer(NVDA, ROUTER, ME, 50n)]);
    expect(netFlow(moves, AAPL, ME.toLowerCase() as Address)).toBe(200n);
    expect(netFlow(moves, AAPL.toLowerCase() as Address, FRIEND)).toBe(100n);
    expect(netFlow(moves, NVDA, ME)).toBe(50n);
    expect(netFlow(moves, NVDA, FRIEND)).toBe(0n);
  });
  it("is zero for a self-transfer and for a wallet the receipt never names", () => {
    const moves = tokenMoves([transfer(AAPL, ME, ME, 10n)]);
    expect(netFlow(moves, AAPL, ME)).toBe(0n);
    expect(netFlow(moves, AAPL, ROUTER)).toBe(0n);
  });
  it("ignores an Approval that shares the Transfer's topic shape", () => {
    expect(tokenMoves([approval(AAPL, ME, ROUTER, 1n)])).toEqual([]);
  });
});

describe("tradeFacts", () => {
  it("proves a buy by the stock arriving, and reads the USDC that paid for it", () => {
    const logs = [transfer(USDC, ME, ROUTER, 1_800_000n), transfer(AAPL, ROUTER, ME, 100_000_000n)];
    const f = tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC });
    expect(f).toEqual({ ok: true, assetAmount: 100_000_000n, usdcAmount: 1_800_000n });
  });

  it("refuses a buy whose stock went somewhere else, whoever paid", () => {
    const logs = [transfer(USDC, ME, ROUTER, 1_800_000n), transfer(AAPL, ROUTER, FRIEND, 100_000_000n)];
    const f = tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC });
    expect(f.ok).toBe(false);
  });

  it("accepts a buy for someone else when the recipient is named, and still charges the buyer's USDC", () => {
    const logs = [transfer(USDC, ME, ROUTER, 1_320_000n), transfer(AAPL, ROUTER, FRIEND, 401_447n)];
    const f = tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", recipient: FRIEND, usdc: USDC });
    expect(f).toEqual({ ok: true, assetAmount: 401_447n, usdcAmount: 1_320_000n });
  });

  it("leaves the USDC unknown when one transaction bought several stocks, so no leg can claim the whole of it", () => {
    const logs = [transfer(USDC, ME, ROUTER, 5_000_000n), transfer(AAPL, ROUTER, ME, 1n), transfer(NVDA, ROUTER, ME, 1n)];
    const aapl = tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC });
    const nvda = tradeFacts(logs, { owner: ME, assetAddress: NVDA, side: "buy", usdc: USDC });
    expect(aapl).toEqual({ ok: true, assetAmount: 1n, usdcAmount: null });
    expect(nvda).toEqual({ ok: true, assetAmount: 1n, usdcAmount: null });
  });

  it("leaves the USDC unknown for a buy paid in ETH", () => {
    const f = tradeFacts([transfer(AAPL, ROUTER, ME, 7n)], { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC });
    expect(f).toEqual({ ok: true, assetAmount: 7n, usdcAmount: null });
  });

  it("proves a sell by the stock leaving, reports the units sold as a positive number, and reads the USDC received", () => {
    const logs = [transfer(AAPL, ME, ROUTER, 50_000_000n), transfer(USDC, ROUTER, ME, 900_000n)];
    const f = tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "sell", usdc: USDC });
    expect(f).toEqual({ ok: true, assetAmount: 50_000_000n, usdcAmount: 900_000n });
  });

  it("refuses a sell where the stock did not leave, even if USDC arrived", () => {
    const f = tradeFacts([transfer(USDC, ROUTER, ME, 900_000n)], { owner: ME, assetAddress: AAPL, side: "sell", usdc: USDC });
    expect(f.ok).toBe(false);
  });

  it("refuses a buy of the wrong stock: the receipt has to show the asset the record names", () => {
    const f = tradeFacts([transfer(NVDA, ROUTER, ME, 1n), transfer(USDC, ME, ROUTER, 1n)], { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC });
    expect(f.ok).toBe(false);
  });

  it("nets a round trip inside one receipt to nothing, which is not a buy", () => {
    const f = tradeFacts([transfer(AAPL, ROUTER, ME, 5n), transfer(AAPL, ME, ROUTER, 5n)], { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC });
    expect(f.ok).toBe(false);
  });
});

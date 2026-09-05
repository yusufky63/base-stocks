import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { findEvent, netFlow, tokenMoves, touches, tradeFacts, type ReceiptLog } from "./receipt-checks";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const ME = "0xeaa823ab4c4ee00283d8ed7be713ddf8a5ba0fac" as Address;
const ROUTER = "0x1111111111111111111111111111111111111111" as Address;
const POOL = "0x2222222222222222222222222222222222222222" as Address;
const FRIEND = "0x3333333333333333333333333333333333333333" as Address;

let index = 0;
function transfer(token: Address, from: Address, to: Address, value: bigint): ReceiptLog {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } });
  return { address: token, topics: topics as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [value]), logIndex: index++ };
}
function approval(token: Address, owner: Address, spender: Address): ReceiptLog {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: "Approval", args: { owner, spender } });
  return { address: token, topics: topics as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [1n]), logIndex: index++ };
}

describe("what a receipt proves", () => {
  it("reads every transfer and ignores approvals that share the topic count", () => {
    const logs = [approval(USDC, ME, ROUTER), transfer(USDC, ME, POOL, 1_800_000n), transfer(AAPL, POOL, ME, 560_168n)];
    const moves = tokenMoves(logs);
    expect(moves).toHaveLength(2);
    expect(netFlow(moves, AAPL, ME)).toBe(560_168n);
    expect(netFlow(moves, USDC, ME)).toBe(-1_800_000n);
  });

  /** A route that refunds a little USDC still nets to what the buyer actually paid. */
  it("proves a buy by the stock arriving and settles the USDC net of refunds", () => {
    const logs = [transfer(USDC, ME, ROUTER, 2_000_000n), transfer(USDC, ROUTER, ME, 200_000n), transfer(AAPL, POOL, ME, 560_168n)];
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC })).toEqual({ ok: true, assetAmount: 560_168n, usdcAmount: 1_800_000n });
  });

  it("proves a buy for someone else by the stock arriving in their wallet, paid by the buyer", () => {
    const logs = [transfer(USDC, ME, ROUTER, 1_320_000n), transfer(AAPL, POOL, FRIEND, 401_447n)];
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", recipient: FRIEND, usdc: USDC })).toEqual({ ok: true, assetAmount: 401_447n, usdcAmount: 1_320_000n });
    // Claiming it went to ME instead is refused: nothing arrived there.
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC }).ok).toBe(false);
  });

  it("proves a sell by the stock leaving, and knows the USDC received", () => {
    const logs = [transfer(AAPL, ME, POOL, 2_727_277n), transfer(USDC, POOL, ME, 8_732_202n)];
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "sell", usdc: USDC })).toEqual({ ok: true, assetAmount: 2_727_277n, usdcAmount: 8_732_202n });
  });

  /**
   * An AutoInvest run buys three stocks in one transaction and the keeper files one record per
   * stock. The USDC that left the owner paid for all three; handing the whole of it to each leg
   * turned a $5 run into $15 of volume. No leg may claim it.
   */
  it("does not hand one transaction's USDC to every stock it bought", () => {
    const logs = [transfer(USDC, ME, ROUTER, 5_000_000n), transfer(AAPL, POOL, ME, 519_361n), transfer(NVDA, POOL, ME, 642_450n)];
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC })).toEqual({ ok: true, assetAmount: 519_361n, usdcAmount: null });
    expect(tradeFacts(logs, { owner: ME, assetAddress: NVDA, side: "buy", usdc: USDC })).toEqual({ ok: true, assetAmount: 642_450n, usdcAmount: null });
  });

  /** A buy paid in ETH moves no USDC from the owner; the stock still proves it, the USD stays the app's figure. */
  it("leaves the settled amount open for a buy paid in ETH", () => {
    const logs = [transfer(AAPL, POOL, ME, 155_970n)];
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "buy", usdc: USDC })).toEqual({ ok: true, assetAmount: 155_970n, usdcAmount: null });
  });

  it("refuses a record whose wallet, stock or side the receipt does not show", () => {
    const logs = [transfer(USDC, ME, ROUTER, 1_800_000n), transfer(AAPL, POOL, ME, 560_168n)];
    expect(tradeFacts(logs, { owner: FRIEND, assetAddress: AAPL, side: "buy", usdc: USDC }).ok).toBe(false);
    expect(tradeFacts(logs, { owner: ME, assetAddress: USDC, side: "buy", usdc: USDC }).ok).toBe(false);
    expect(tradeFacts(logs, { owner: ME, assetAddress: AAPL, side: "sell", usdc: USDC }).ok).toBe(false);
  });

  it("finds a named event by contract and arguments", () => {
    const abi = parseAbi(["event PoolClaimed(bytes32 indexed id, address indexed recipient, uint32 index)"]);
    const id = `0x${"ab".repeat(32)}` as Hex;
    const topics = encodeEventTopics({ abi, eventName: "PoolClaimed", args: { id, recipient: ME } });
    const logs: ReceiptLog[] = [{ address: POOL, topics: topics as Hex[], data: encodeAbiParameters([{ type: "uint32" }], [3]), logIndex: 9 }];
    const hit = findEvent<{ id: Hex; recipient: Address; index: number }>(logs, abi, POOL, "PoolClaimed", (a) => a.id === id);
    expect(hit?.recipient.toLowerCase()).toBe(ME);
    expect(hit?.index).toBe(3);
    expect(findEvent(logs, abi, POOL, "PoolClaimed", (a) => (a as { id: Hex }).id !== id)).toBeNull();
    expect(findEvent(logs, abi, ROUTER, "PoolClaimed")).toBeNull();
    expect(touches(logs, [POOL])).toBe(true);
    expect(touches(logs, [ROUTER])).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, keccak256, pad, toBytes, type Abi, type AbiEvent, type Address, type Hash, type Hex } from "viem";
import { AAVE_SUPPLY, AAVE_WITHDRAW, COMET_SUPPLY, ERC4626_WITHDRAW, type EarnVenue } from "@/lib/earn/venue-events";
import { GIFT_ESCROW_ADDRESS, LEGACY_GIFT_ESCROW_ADDRESSES, giftEscrowAbi } from "@/lib/escrow";
import { LEGACY_GIFT_POOL_ADDRESSES, giftPoolAbi } from "@/lib/pool";

/**
 * The verifiers against synthetic receipts built from the contracts' own ABIs. The RPC is a double
 * and the receipt cache passes through, so each test decides exactly what the chain says.
 */
const h = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  putMany: vi.fn(),
  blockTimes: vi.fn(),
  earnVenues: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/viem/server-client", () => ({ getServerPublicClient: () => ({ getTransactionReceipt: h.getTransactionReceipt }) }));
vi.mock("@/db/repositories", () => ({ getRepos: () => ({ receipts: { putMany: h.putMany } }) }));
vi.mock("@/lib/cache", () => ({ cached: (_key: string, _opts: unknown, load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/http", () => ({ metrics: { count: h.count } }));
vi.mock("./earn-reconcile-service", () => ({ earnVenues: () => h.earnVenues() }));
vi.mock("./receipt-service", () => ({ blockTimes: (...a: unknown[]) => h.blockTimes(...a) }));

import { verdictError, verifyEarn, verifyGift, verifyGiftClaim, verifyGiftReclaim, verifyPoolCancel, verifyPoolClaim, verifyPoolCreate, verifyTrade } from "./tx-verify-service";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const ME = "0xEAa823AB4C4eE00283d8ed7be713ddf8A5ba0Fac" as Address;
const FRIEND = "0x3333333333333333333333333333333333333333" as Address;
const STRANGER = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const ROUTER = "0x1111111111111111111111111111111111111111" as Address;
const POOL = "0x2222222222222222222222222222222222222222" as Address;
const BUNDLER = "0x000000000000000000000000000000000000dEaD" as Address;
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
const SETTLEMENT = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" as Address;
const UNISWAP_NPM = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1" as Address;
const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address;
const VAULT = "0x4444444444444444444444444444444444444444" as Address;
const COMET = "0xb125E6687d4313864e53df431d5425969c15Eb2F" as Address;
const ESCROW = GIFT_ESCROW_ADDRESS;
const LEGACY_ESCROW = LEGACY_GIFT_ESCROW_ADDRESSES[0]!;
const GIFT_POOL = LEGACY_GIFT_POOL_ADDRESSES[0]!;
const ESCROW_ID = `0x${"e".repeat(64)}` as Hex;
const POOL_ID = `0x${"a".repeat(64)}` as Hex;
const TX = `0x${"1".repeat(64)}` as Hash;
const BLOCK = 30_000_000;
const BLOCK_TIME = 1_790_000_000;

/* --------------------------------- receipts -------------------------------- */

type Log = { address: Address; topics: Hex[]; data: Hex; logIndex: number };
let index = 0;

/** Topics and data for one event of `abi`, split by the ABI's own `indexed` flags. */
function event(address: Address, abi: Abi, eventName: string, args: Record<string, unknown>): Log {
  const item = abi.find((x): x is AbiEvent => x.type === "event" && x.name === eventName)!;
  const indexed = Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]));
  const rest = item.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: [item], eventName, args: indexed } as never) as Hex[];
  return { address, topics, data: encodeAbiParameters(rest, rest.map((i) => args[i.name!])), logIndex: index++ };
}
const transfer = (token: Address, from: Address, to: Address, value: bigint) => event(token, erc20Abi, "Transfer", { from, to, value });
const userOperation = (sender: Address): Log => ({
  address: ENTRY_POINT,
  topics: [keccak256(toBytes("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")), pad("0x01", { size: 32 }), pad(sender, { size: 32 }), pad(BUNDLER, { size: 32 })],
  data: "0x",
  logIndex: index++,
});
/** Any log the position manager emits; its own events are not decoded, only its presence counts. */
const managerLog = (manager: Address = UNISWAP_NPM): Log => ({ address: manager, topics: [keccak256(toBytes("IncreaseLiquidity(uint256,uint128,uint256,uint256)")), pad("0x01", { size: 32 })], data: "0x", logIndex: index++ });
const cowTrade = (owner: Address): Log => ({ address: SETTLEMENT, topics: [keccak256(toBytes("Trade(address,address,address,uint256,uint256,uint256,bytes)")), pad(owner, { size: 32 })], data: "0x", logIndex: index++ });

function mined(logs: Log[], opts: { from?: Address; status?: "success" | "reverted" } = {}) {
  h.getTransactionReceipt.mockResolvedValue({ status: opts.status ?? "success", blockNumber: BigInt(BLOCK), from: opts.from ?? ME, logs });
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.blockTimes.mockResolvedValue(new Map([[BLOCK, BLOCK_TIME]]));
  h.putMany.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------- trades --------------------------------- */

describe("verifyTrade", () => {
  it("proves a buy by the stock arriving, reads the USDC paid, and stores the receipt", async () => {
    mined([transfer(USDC, ME, ROUTER, 25_000_000n), transfer(NVDA, POOL, ME, 13_500_000n)]);
    const v = await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" });
    expect(v).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME, assetAmount: 13_500_000n, usdcAmount: 25_000_000n, initiatedByOwner: true });
    expect(h.putMany).toHaveBeenCalledWith([{ txHash: TX, status: "success", blockNumber: BLOCK, blockTime: BLOCK_TIME }]);
  });

  it("proves a sell by the stock leaving and reads the USDC received", async () => {
    mined([transfer(NVDA, ME, POOL, 1_000_000n), transfer(USDC, POOL, ME, 1_840_000n)]);
    const v = await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "sell" });
    expect(v).toMatchObject({ ok: true, assetAmount: 1_000_000n, usdcAmount: 1_840_000n });
  });

  it("proves a buy for someone else by the stock arriving in the recipient's wallet", async () => {
    mined([transfer(USDC, ME, ROUTER, 5_000_000n), transfer(NVDA, POOL, FRIEND, 2_700_000n)]);
    expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy", recipient: FRIEND })).toMatchObject({ ok: true, assetAmount: 2_700_000n });
    // The same receipt does not prove a buy into the payer's own wallet.
    expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: false, state: "mismatch" });
  });

  it("refuses a receipt whose stock went to a different wallet", async () => {
    mined([transfer(USDC, ME, ROUTER, 25_000_000n), transfer(NVDA, POOL, STRANGER, 13_500_000n)]);
    const v = await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" });
    expect(v).toEqual({ ok: false, state: "mismatch", reason: "The stock did not arrive in that wallet in this transaction." });
    expect(h.count).toHaveBeenCalledWith("verify.mismatch", false, expect.any(String));
    expect(h.putMany).not.toHaveBeenCalled();
  });

  it("refuses a receipt that moved a different stock", async () => {
    mined([transfer(USDC, ME, ROUTER, 25_000_000n), transfer(AAPL, POOL, ME, 9_000_000n)]);
    expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: false, state: "mismatch" });
  });

  it("refuses a sell whose stock did not leave the wallet", async () => {
    mined([transfer(NVDA, POOL, ME, 1n)]);
    expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "sell" })).toEqual({ ok: false, state: "mismatch", reason: "The stock did not leave that wallet in this transaction." });
  });

  it("keeps the chain's amounts, never the caller's", async () => {
    mined([transfer(USDC, ME, ROUTER, 1_000_000n), transfer(NVDA, POOL, ME, 7n)]);
    const v = await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" });
    expect(v).toMatchObject({ ok: true, assetAmount: 7n, usdcAmount: 1_000_000n });
  });

  it("reports a reverted receipt as reverted, and still stores it", async () => {
    mined([], { status: "reverted" });
    expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toEqual({ ok: false, state: "reverted", reason: "The transaction reverted onchain." });
    expect(h.putMany).toHaveBeenCalledWith([{ txHash: TX, status: "reverted", blockNumber: BLOCK, blockTime: BLOCK_TIME }]);
  });

  it("reports an unknown hash as pending after a few tries, not as a failure", async () => {
    vi.useFakeTimers();
    h.getTransactionReceipt.mockRejectedValue(new Error("TransactionReceiptNotFoundError"));
    const pending = verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: false, state: "pending", reason: expect.stringMatching(/not mined yet/) });
    expect(h.getTransactionReceipt).toHaveBeenCalledTimes(3);
    expect(h.putMany).not.toHaveBeenCalled();
  });

  it("recovers when the receipt shows up on a retry", async () => {
    vi.useFakeTimers();
    h.getTransactionReceipt.mockRejectedValueOnce(new Error("not found")).mockResolvedValueOnce({ status: "success", blockNumber: BigInt(BLOCK), from: ME, logs: [transfer(NVDA, POOL, ME, 5n)] });
    const pending = verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ ok: true, assetAmount: 5n });
  });

  it("a missing block time does not fail the verdict", async () => {
    h.blockTimes.mockRejectedValue(new Error("rpc"));
    h.putMany.mockRejectedValue(new Error("db"));
    mined([transfer(NVDA, POOL, ME, 5n)]);
    const v = await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" });
    expect(v).toMatchObject({ ok: true, blockNumber: BLOCK, blockTime: undefined });
  });

  describe("who initiated it", () => {
    const bought = () => [transfer(USDC, ME, ROUTER, 1_000_000n), transfer(NVDA, POOL, ME, 5n)];

    it("the transaction's sender", async () => {
      mined(bought(), { from: ME });
      expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: true, initiatedByOwner: true });
    });

    it("the ERC-4337 user operation's sender, when a bundler sent it", async () => {
      mined([userOperation(ME), ...bought()], { from: BUNDLER });
      expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: true, initiatedByOwner: true });
    });

    it("the CoW order's owner, when a solver settled it", async () => {
      mined([cowTrade(ME), ...bought()], { from: BUNDLER });
      expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: true, initiatedByOwner: true });
    });

    it("nobody the wallet controls: still proven, but not initiated by the owner", async () => {
      mined([userOperation(STRANGER), cowTrade(STRANGER), ...bought()], { from: STRANGER });
      expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: true, initiatedByOwner: false });
    });

    it("a receipt cached before `from` was kept is not initiated by anyone", async () => {
      h.getTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: BigInt(BLOCK), logs: bought() });
      expect(await verifyTrade({ txHash: TX, owner: ME, assetAddress: NVDA, side: "buy" })).toMatchObject({ ok: true, initiatedByOwner: false });
    });
  });
});

/* ----------------------------------- earn ---------------------------------- */

describe("verifyEarn", () => {
  const venues: EarnVenue[] = [
    { kind: "aave", address: AAVE_POOL, provider: "aave", opportunityId: "aave-usdc" },
    { kind: "erc4626", address: VAULT, provider: "morpho", opportunityId: "morpho-vault" },
    { kind: "comet", address: COMET, provider: "compound", opportunityId: "comet-usdc" },
  ];
  beforeEach(() => {
    h.earnVenues.mockResolvedValue(venues);
  });

  it("proves an Aave supply by the pool crediting the wallet, and keeps the pool's amount", async () => {
    mined([event(AAVE_POOL, [AAVE_SUPPLY], "Supply", { reserve: USDC, user: BUNDLER, onBehalfOf: ME, amount: 100_000_000n, referralCode: 0 })], { from: BUNDLER });
    const v = await verifyEarn({ txHash: TX, owner: ME, provider: "aave", action: "deposit" });
    expect(v).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME, amount: 100_000_000n, initiatedByOwner: false, moves: [] });
  });

  it("refuses an Aave supply credited to someone else", async () => {
    mined([event(AAVE_POOL, [AAVE_SUPPLY], "Supply", { reserve: USDC, user: ME, onBehalfOf: STRANGER, amount: 100_000_000n, referralCode: 0 })]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "aave", action: "deposit" })).toEqual({ ok: false, state: "mismatch", reason: "That venue did not record this wallet in that transaction." });
  });

  it("refuses a same-shaped event from a contract that is not the venue", async () => {
    mined([event(POOL, [AAVE_SUPPLY], "Supply", { reserve: USDC, user: ME, onBehalfOf: ME, amount: 1n, referralCode: 0 })]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "aave", action: "deposit" })).toMatchObject({ ok: false, state: "mismatch" });
  });

  it("does not take a deposit for a withdrawal", async () => {
    mined([event(AAVE_POOL, [AAVE_SUPPLY], "Supply", { reserve: USDC, user: ME, onBehalfOf: ME, amount: 1n, referralCode: 0 })]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "aave", action: "withdraw" })).toMatchObject({ ok: false, state: "mismatch" });
    mined([event(AAVE_POOL, [AAVE_WITHDRAW], "Withdraw", { reserve: USDC, user: ME, to: ME, amount: 3n })]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "aave", action: "withdraw" })).toMatchObject({ ok: true, amount: 3n, initiatedByOwner: true });
  });

  it("proves a vault withdrawal by its owner, not its receiver", async () => {
    mined([event(VAULT, [ERC4626_WITHDRAW], "Withdraw", { sender: ME, receiver: FRIEND, owner: ME, assets: 42_000_000n, shares: 40_000_000n })]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "morpho", action: "withdraw" })).toMatchObject({ ok: true, amount: 42_000_000n });
    expect(await verifyEarn({ txHash: TX, owner: FRIEND, provider: "morpho", action: "withdraw" })).toMatchObject({ ok: false, state: "mismatch" });
  });

  it("proves a Comet supply by its destination", async () => {
    mined([event(COMET, [COMET_SUPPLY], "Supply", { from: BUNDLER, dst: ME, amount: 9n })]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "compound", action: "deposit" })).toMatchObject({ ok: true, amount: 9n });
  });

  it("refuses an unknown venue and a lending collect", async () => {
    mined([]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "nowhere", action: "deposit" })).toEqual({ ok: false, state: "mismatch", reason: "Unknown Earn venue." });
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "aave", action: "collect" })).toEqual({ ok: false, state: "mismatch", reason: "Only liquidity positions collect fees." });
  });

  it("proves a liquidity action by the position manager acting and the wallet's tokens moving", async () => {
    mined([managerLog(), transfer(USDC, ME, POOL, 10_000_000n), transfer(NVDA, ME, POOL, 5_000_000n), transfer(AAPL, POOL, STRANGER, 1n)]);
    const v = await verifyEarn({ txHash: TX, owner: ME, provider: "uniswap", action: "deposit" });
    expect(v).toMatchObject({ ok: true, amount: null, initiatedByOwner: true });
    // Only the wallet's own moves, which the route then prices and bounds.
    expect(v.ok && v.moves.map((m) => [m.token, m.value])).toEqual([
      [USDC, 10_000_000n],
      [NVDA, 5_000_000n],
    ]);
  });

  it("refuses a liquidity action the manager took no part in, or that moved none of the wallet's tokens", async () => {
    mined([transfer(USDC, ME, POOL, 10_000_000n)]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "uniswap", action: "deposit" })).toEqual({ ok: false, state: "mismatch", reason: "No position manager of that venue acted in that transaction." });
    mined([managerLog(), transfer(USDC, STRANGER, POOL, 1n)]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "uniswap", action: "collect" })).toEqual({ ok: false, state: "mismatch", reason: "None of that wallet's tokens moved in that transaction." });
  });

  it("the other venue's manager does not count", async () => {
    mined([managerLog(), transfer(USDC, ME, POOL, 1n)]);
    expect(await verifyEarn({ txHash: TX, owner: ME, provider: "aerodrome", action: "deposit" })).toMatchObject({ ok: false, state: "mismatch" });
  });
});

/* ----------------------------------- gifts --------------------------------- */

describe("gift verifiers", () => {
  const link = { kind: "claim-link" as const, sender: ME, recipient: "0x0000000000000000000000000000000000000000" as Address, assetAddress: NVDA, escrowId: ESCROW_ID, escrowAddress: ESCROW };
  const created = (over: Record<string, unknown> = {}, at: Address = ESCROW) => event(at, giftEscrowAbi as Abi, "GiftCreated", { id: ESCROW_ID, sender: ME, token: NVDA, amount: 1_000_000n, expiry: 1_795_000_000n, memoRef: `0x${"0".repeat(64)}`, ...over });

  it("proves a claim link by the escrow's GiftCreated and takes the amount and expiry from it", async () => {
    mined([transfer(NVDA, ME, ESCROW, 1_000_000n), created()]);
    expect(await verifyGift(link, TX)).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME, amount: 1_000_000n, expiresAt: 1_795_000_000_000 });
  });

  it("a record without an escrow address lives in the legacy escrow, and only its events count", async () => {
    const legacy = { ...link, escrowAddress: undefined };
    mined([created({}, ESCROW)]);
    expect(await verifyGift(legacy, TX)).toMatchObject({ ok: false, state: "mismatch" });
    mined([created({}, LEGACY_ESCROW)]);
    expect(await verifyGift(legacy, TX)).toMatchObject({ ok: true, amount: 1_000_000n });
  });

  it("refuses an escrow this app does not know, however well formed its GiftCreated", async () => {
    mined([created({}, POOL)]);
    const v = await verifyGift({ ...link, escrowAddress: POOL }, TX);
    expect(v).toEqual({ ok: false, state: "mismatch", reason: "The gift names an escrow contract this app does not know." });
  });

  it.each([
    ["another escrow id", { id: `0x${"f".repeat(64)}` }, /No GiftCreated/],
    ["a different sender", { sender: STRANGER }, /different sender/],
    ["a different stock", { token: AAPL }, /different stock/],
  ])("refuses a GiftCreated with %s", async (_label, over, reason) => {
    mined([created(over)]);
    expect(await verifyGift(link, TX)).toEqual({ ok: false, state: "mismatch", reason: expect.stringMatching(reason) });
  });

  it("refuses a claim link with no escrow id", async () => {
    mined([created()]);
    expect(await verifyGift({ ...link, escrowId: undefined }, TX)).toMatchObject({ ok: false, reason: "The gift has no escrow id to match." });
  });

  it("proves a direct send by the stock moving from sender to recipient", async () => {
    const send = { ...link, kind: "send-existing" as const, recipient: FRIEND };
    mined([transfer(NVDA, ME, FRIEND, 3n)]);
    expect(await verifyGift(send, TX)).toMatchObject({ ok: true, amount: 3n });
    mined([transfer(NVDA, ME, STRANGER, 3n)]);
    expect(await verifyGift(send, TX)).toMatchObject({ ok: false, state: "mismatch" });
    mined([transfer(AAPL, ME, FRIEND, 3n)]);
    expect(await verifyGift(send, TX)).toMatchObject({ ok: false, state: "mismatch" });
  });

  it("proves a buy for a recipient by the net amount that arrived in their wallet", async () => {
    const buy = { ...link, kind: "buy-for-recipient" as const, recipient: FRIEND };
    mined([transfer(USDC, ME, ROUTER, 5_000_000n), transfer(NVDA, POOL, FRIEND, 10n), transfer(NVDA, FRIEND, POOL, 4n)]);
    expect(await verifyGift(buy, TX)).toMatchObject({ ok: true, amount: 6n });
    mined([transfer(NVDA, POOL, ME, 10n)]);
    expect(await verifyGift(buy, TX)).toEqual({ ok: false, state: "mismatch", reason: "The stock did not arrive in the recipient's wallet in that transaction." });
  });

  it("verifyGiftClaim names the recipient from the escrow's log", async () => {
    mined([event(ESCROW, giftEscrowAbi as Abi, "GiftClaimed", { id: ESCROW_ID, recipient: FRIEND, token: NVDA, amount: 1_000_000n })], { from: BUNDLER });
    expect(await verifyGiftClaim({ escrowId: ESCROW_ID, escrowAddress: ESCROW }, TX)).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME, recipient: FRIEND, amount: 1_000_000n });
  });

  it("verifyGiftClaim refuses another gift's claim, a stranger's escrow, and a record without an id", async () => {
    mined([event(ESCROW, giftEscrowAbi as Abi, "GiftClaimed", { id: `0x${"f".repeat(64)}`, recipient: FRIEND, token: NVDA, amount: 1n })]);
    expect(await verifyGiftClaim({ escrowId: ESCROW_ID, escrowAddress: ESCROW }, TX)).toMatchObject({ ok: false, reason: "No GiftClaimed for this escrow id in that transaction." });
    h.getTransactionReceipt.mockClear();
    expect(await verifyGiftClaim({ escrowId: ESCROW_ID, escrowAddress: POOL }, TX)).toMatchObject({ ok: false, state: "mismatch" });
    expect(await verifyGiftClaim({ escrowId: undefined, escrowAddress: ESCROW }, TX)).toMatchObject({ ok: false, state: "mismatch" });
    expect(h.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("verifyGiftClaim passes a reverted claim through as reverted", async () => {
    mined([], { status: "reverted" });
    expect(await verifyGiftClaim({ escrowId: ESCROW_ID, escrowAddress: ESCROW }, TX)).toMatchObject({ ok: false, state: "reverted" });
  });

  it("verifyGiftReclaim needs the escrow to have refunded this sender", async () => {
    const gift = { escrowId: ESCROW_ID, sender: ME, escrowAddress: ESCROW };
    mined([event(ESCROW, giftEscrowAbi as Abi, "GiftReclaimed", { id: ESCROW_ID, sender: ME, token: NVDA, amount: 1n })]);
    expect(await verifyGiftReclaim(gift, TX)).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME });
    mined([event(ESCROW, giftEscrowAbi as Abi, "GiftReclaimed", { id: ESCROW_ID, sender: STRANGER, token: NVDA, amount: 1n })]);
    expect(await verifyGiftReclaim(gift, TX)).toEqual({ ok: false, state: "mismatch", reason: "The escrow refunded a different sender." });
    mined([event(ESCROW, giftEscrowAbi as Abi, "GiftClaimed", { id: ESCROW_ID, recipient: ME, token: NVDA, amount: 1n })]);
    expect(await verifyGiftReclaim(gift, TX)).toMatchObject({ ok: false, reason: "No GiftReclaimed for this escrow id in that transaction." });
  });
});

/* ----------------------------------- pools --------------------------------- */

describe("pool verifiers", () => {
  const pool = { onchainId: POOL_ID, creator: ME, contractAddress: undefined };
  const OTHER_ID = `0x${"b".repeat(64)}` as Hex;
  const poolCreated = (over: Record<string, unknown> = {}) => event(GIFT_POOL, giftPoolAbi as Abi, "PoolCreated", { id: POOL_ID, creator: ME, gate: STRANGER, slots: 25, expiry: 1_795_000_000n, lockedUntil: 1_791_000_000n, memoRef: `0x${"0".repeat(64)}`, ...over });
  const poolLeg = (token: Address, amountPerClaim: bigint, id: Hex = POOL_ID, at: Address = GIFT_POOL) => event(at, giftPoolAbi as Abi, "PoolLeg", { id, token, amountPerClaim });

  it("verifyPoolCreate reads the terms and every leg of this pool from the contract's events", async () => {
    mined([poolCreated(), poolLeg(NVDA, 100n), poolLeg(AAPL, 7n, OTHER_ID), poolLeg(AAPL, 9n, POOL_ID, POOL), poolLeg(AAPL, 200n)]);
    expect(await verifyPoolCreate(pool, TX)).toEqual({
      ok: true,
      blockNumber: BLOCK,
      blockTime: BLOCK_TIME,
      gate: STRANGER,
      slots: 25,
      expiry: 1_795_000_000_000,
      lockedUntil: 1_791_000_000_000,
      legs: [
        { token: NVDA, amountPerClaim: "100" },
        { token: AAPL, amountPerClaim: "200" },
      ],
    });
  });

  it("verifyPoolCreate refuses another creator, a pool without stock, and another pool's event", async () => {
    mined([poolCreated({ creator: STRANGER }), poolLeg(NVDA, 1n)]);
    expect(await verifyPoolCreate(pool, TX)).toMatchObject({ ok: false, reason: "The pool was created by a different wallet." });
    mined([poolCreated()]);
    expect(await verifyPoolCreate(pool, TX)).toMatchObject({ ok: false, reason: "The pool was created without any stock in it." });
    mined([poolCreated({ id: OTHER_ID }), poolLeg(NVDA, 1n, OTHER_ID)]);
    expect(await verifyPoolCreate(pool, TX)).toMatchObject({ ok: false, reason: "No PoolCreated for this pool in that transaction." });
  });

  it("refuses a pool that names a contract this app does not know, without reading the chain", async () => {
    const stray = { ...pool, contractAddress: POOL };
    expect(await verifyPoolCreate(stray, TX)).toMatchObject({ ok: false, reason: "The pool names a contract this app does not know." });
    expect(await verifyPoolClaim(stray, ME, TX)).toMatchObject({ ok: false, state: "mismatch" });
    expect(await verifyPoolCancel(stray, TX)).toMatchObject({ ok: false, state: "mismatch" });
    expect(h.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("verifyPoolClaim needs PoolClaimed for this pool and this claimant", async () => {
    mined([event(GIFT_POOL, giftPoolAbi as Abi, "PoolClaimed", { id: POOL_ID, recipient: FRIEND, index: 3 })], { from: BUNDLER });
    expect(await verifyPoolClaim(pool, FRIEND, TX)).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME });
    expect(await verifyPoolClaim(pool, STRANGER, TX)).toEqual({ ok: false, state: "mismatch", reason: "No PoolClaimed for this wallet and pool in that transaction." });
    expect(await verifyPoolClaim({ ...pool, onchainId: OTHER_ID }, FRIEND, TX)).toMatchObject({ ok: false, state: "mismatch" });
  });

  it("verifyPoolCancel needs PoolCancelled for this pool", async () => {
    mined([event(GIFT_POOL, giftPoolAbi as Abi, "PoolCancelled", { id: POOL_ID, creator: ME })]);
    expect(await verifyPoolCancel(pool, TX)).toEqual({ ok: true, blockNumber: BLOCK, blockTime: BLOCK_TIME });
    mined([event(GIFT_POOL, giftPoolAbi as Abi, "PoolCancelled", { id: OTHER_ID, creator: ME })]);
    expect(await verifyPoolCancel(pool, TX)).toMatchObject({ ok: false, reason: "No PoolCancelled for this pool in that transaction." });
  });

  it("a pending pool transaction is pending for every pool verifier", async () => {
    vi.useFakeTimers();
    h.getTransactionReceipt.mockRejectedValue(new Error("not found"));
    const all = Promise.all([verifyPoolCreate(pool, TX), verifyPoolClaim(pool, ME, TX), verifyPoolCancel(pool, TX)]);
    await vi.runAllTimersAsync();
    for (const v of await all) expect(v).toMatchObject({ ok: false, state: "pending" });
  });
});

describe("verdictError", () => {
  it("maps each state to its HTTP answer and keeps only the reason", () => {
    expect(verdictError({ ok: false, state: "pending", reason: "wait" })).toEqual({ code: "TX_PENDING", status: 409, message: "wait" });
    expect(verdictError({ ok: false, state: "reverted", reason: "boom" })).toEqual({ code: "TX_REVERTED", status: 409, message: "boom" });
    expect(verdictError({ ok: false, state: "mismatch", reason: "nope" })).toEqual({ code: "TX_MISMATCH", status: 400, message: "nope" });
  });
});

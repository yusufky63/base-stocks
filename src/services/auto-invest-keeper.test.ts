import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { AutomationOnchain, AutomationRule } from "@/domain/community";
import { MemoryAutomationRepo } from "@/db/community-repos";
import { autoInvestAbi, type OnchainPlan } from "@/lib/auto-invest";

/**
 * The keeper tick against in-memory rules and a scripted chain. The wallet client is a double that
 * hands back hashes, so nothing here signs or sends a real transaction; the key is generated per run.
 */
const h = vi.hoisted(() => ({
  V2: "0x708e63F591E4983b2B233C71EA1283ca98e4C97a",
  V1: "0xc767844F2D65ba241DBe2c04f9c01d05cCD9b60E",
  env: { AUTOMATION_MAX_RUNS_PER_TICK: 6 } as { AUTOMATION_MAX_RUNS_PER_TICK: number },
  deployed: true,
  account: null as unknown,
  wallet: null as unknown,
  repos: null as unknown,
  client: null as unknown,
  getAssets: vi.fn(),
  views: new Map<string, unknown>(),
  quote: vi.fn(),
  chain: { readFloor: vi.fn(), readFunding: vi.fn(), readOnchainPlan: vi.fn(), readOnchainPlans: vi.fn(), readRouteAllowed: vi.fn() },
}));

vi.mock("@/config/env", () => ({ serverEnv: () => h.env }));
vi.mock("@/lib/http", () => ({ metrics: { count: vi.fn() } }));
vi.mock("@/db/repositories", () => ({ getRepos: () => h.repos }));
vi.mock("@/lib/viem/server-client", () => ({ getServerPublicClient: () => h.client }));
vi.mock("@/lib/viem/keeper-client", () => ({ keeperAccount: () => h.account, getKeeperWalletClient: () => h.wallet }));
vi.mock("./b20-asset-service", () => ({ getAssets: (...a: unknown[]) => h.getAssets(...a) }));
vi.mock("./price-service", () => ({ getPriceViews: async () => h.views }));
vi.mock("./trade-router", () => ({ tradeRouter: { quote: (...a: unknown[]) => h.quote(...a) } }));
vi.mock("./portfolio-service", () => ({ invalidatePortfolioSnapshot: vi.fn(), validateAllocations: vi.fn() }));
vi.mock("./tx-verify-service", () => ({ verifyTrade: vi.fn() }));
vi.mock("./auto-invest-chain", () => h.chain);
// Pinned so the suite does not depend on NEXT_PUBLIC_AUTO_INVEST_ADDRESS in whatever shell runs it.
vi.mock("@/lib/auto-invest", async (orig) => {
  const actual = await orig<typeof import("@/lib/auto-invest")>();
  const known = [h.V2, h.V1] as Address[];
  return {
    ...actual,
    KNOWN_AUTO_INVEST_ADDRESSES: known,
    isAutoInvestDeployed: () => h.deployed,
    isKnownAutoInvest: (a: string | null | undefined) => typeof a === "string" && known.some((k) => k.toLowerCase() === a.toLowerCase()),
  };
});

import { RUN_LOCK_MS } from "./automation-service";
import { buildRunSwaps, executeRun, outcomeFromReceipt, runDuePlans } from "./auto-invest-keeper";

const V2 = h.V2 as Address;
const V1 = h.V1 as Address;
const OWNER = "0x78de409a6306550882328E2a67160471368387FF" as Address;
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb" as Address;
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as Address;
const SPENDER = "0x57df6092665eb6058DE53939612413ff4B09114E" as Address;
const OKX_ROUTER = "0x00000000000000000000000000000000000000b1" as Address;
const FEED = "0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const SEC = Math.floor(NOW / 1000);
const HOUR = 3_600_000;

const KEY = generatePrivateKey();
const KEEPER = privateKeyToAccount(KEY);

const txHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hash;

/* ------------------------------- the chain -------------------------------- */

type Log = { address: Address; topics: Hex[]; data: Hex; logIndex: number };
let logIndex = 0;
const legFilled = (contract: Address, planId: bigint, asset: Address, spent: bigint, received: bigint): Log => ({
  address: contract,
  topics: encodeEventTopics({ abi: autoInvestAbi, eventName: "LegFilled", args: { planId, asset } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [spent, received]),
  logIndex: logIndex++,
});
const legSkipped = (contract: Address, planId: bigint, asset: Address): Log => ({
  address: contract,
  topics: encodeEventTopics({ abi: autoInvestAbi, eventName: "LegSkipped", args: { planId, asset } }) as Hex[],
  data: "0x",
  logIndex: logIndex++,
});
const planExecuted = (contract: Address, planId: bigint, spent: bigint): Log => ({
  address: contract,
  topics: encodeEventTopics({ abi: autoInvestAbi, eventName: "PlanExecuted", args: { planId, run: 4 } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint40" }], [spent, SEC + 7 * 86_400]),
  logIndex: logIndex++,
});
const revert = (errorName: string, args?: readonly unknown[]) => new ContractFunctionRevertedError({ abi: autoInvestAbi, data: encodeErrorResult({ abi: autoInvestAbi, errorName, args } as never), functionName: "execute" });

const plans = new Map<string, OnchainPlan>();
const planKey = (contract: Address, id: bigint) => `${contract.toLowerCase()}:${id}`;

const plan = (over: Partial<OnchainPlan> = {}): OnchainPlan => ({
  contract: V2,
  planId: 7n,
  owner: OWNER,
  amountPerRun: 50_000_000n,
  interval: 7 * 86_400,
  nextRunAt: SEC - 60,
  expiry: 0,
  maxSlippageBps: 300,
  runs: 3,
  lastRunAt: SEC - 7 * 86_400,
  status: "active",
  legs: [
    { asset: NVDA, weightBps: 6_000 },
    { asset: AAPL, weightBps: 4_000 },
  ],
  ...over,
});

/** The mirror exactly as the keeper would write it, so a fresh tick has nothing to refresh. */
const mirror = (p: OnchainPlan): AutomationOnchain => ({
  contract: p.contract,
  planId: p.planId.toString(),
  syncedAt: 0,
  status: p.status,
  nextRunAt: p.nextRunAt * 1000,
  lastRunAt: p.lastRunAt * 1000,
  runs: p.runs,
  amountPerRun: p.amountPerRun.toString(),
  interval: p.interval,
  expiryAt: p.expiry * 1000,
  maxSlippageBps: p.maxSlippageBps,
});

let automation: MemoryAutomationRepo;
let created = 0;
async function seed(p: OnchainPlan, config: Partial<AutomationRule["config"]> = {}): Promise<AutomationRule> {
  plans.set(planKey(p.contract, p.planId), p);
  const rule: AutomationRule = {
    id: `auto_${p.planId}`,
    owner: p.owner,
    type: "recurring-basket",
    config: { mode: "auto", basketName: "Chips", onchain: mirror(p), history: [], ...config },
    status: "active",
    createdAt: ++created,
    updatedAt: created,
  };
  return automation.create(rule);
}
const stored = async (id: string) => (await automation.listAll()).find((r) => r.id === id)!;

/** What the chain would log for a run the double sent: every non-empty swap filled at twice its USDC. */
const sent = new Map<Hash, { address: Address; args: readonly [bigint, ReadonlyArray<{ amountIn: bigint }>] }>();
function receiptFor(hash: Hash, status: "success" | "reverted" = "success") {
  const req = sent.get(hash)!;
  const p = plans.get(planKey(req.address, req.args[0]))!;
  const logs: Log[] = [];
  let total = 0n;
  req.args[1].forEach((s, i) => {
    if (s.amountIn === 0n) logs.push(legSkipped(req.address, p.planId, p.legs[i]!.asset));
    else logs.push(legFilled(req.address, p.planId, p.legs[i]!.asset, s.amountIn, s.amountIn * 2n));
    total += s.amountIn;
  });
  logs.push(planExecuted(req.address, p.planId, total));
  return { status, to: req.address, logs };
}

const client = { getBalance: vi.fn(), simulateContract: vi.fn(), waitForTransactionReceipt: vi.fn(), getTransactionReceipt: vi.fn() };
const wallet = { writeContract: vi.fn() };
const trades = { create: vi.fn() };
let hashes = 0;

const asset = (address: Address, symbol: string, over: Record<string, unknown> = {}) => ({ address, canonicalId: address.toLowerCase(), symbol, status: "active", totalSupply: 10n ** 20n, oracle: { feed: FEED }, ...over });
const allowedQuote = (req: { provider?: string }) => ({ provider: req.provider ?? "kyber", transaction: { to: ROUTER, data: "0x1234" as Hex, value: "0" }, allowanceSpender: SPENDER, buyAmount: "100000000", minBuyAmount: "97000000" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const f of [...Object.values(client), wallet.writeContract, trades.create, h.getAssets, h.quote, ...Object.values(h.chain)]) f.mockReset();
  plans.clear();
  sent.clear();
  hashes = 0;
  h.env.AUTOMATION_MAX_RUNS_PER_TICK = 6;
  h.deployed = true;
  h.account = KEEPER;
  h.wallet = wallet;
  h.client = client;
  automation = new MemoryAutomationRepo();
  h.repos = { automation, trades };
  h.getAssets.mockResolvedValue([asset(NVDA, "NVDAc"), asset(AAPL, "AAPLc")]);
  h.views = new Map([NVDA, AAPL].map((a) => [a.toLowerCase(), { liquidityUsd: 5_000_000, volume24hUsd: 500_000 }]));
  h.quote.mockImplementation(async (req: { provider?: string }) => allowedQuote(req));
  h.chain.readRouteAllowed.mockResolvedValue({ router: true, spender: true });
  h.chain.readFloor.mockResolvedValue(95_000_000n);
  h.chain.readFunding.mockResolvedValue({ usdcBalance: "1000000000", allowance: "1000000000", enough: true, runsCovered: 20 });
  h.chain.readOnchainPlans.mockImplementation(async (refs: Array<{ contract: Address; planId: bigint }>) => refs.map((r) => plans.get(planKey(r.contract, r.planId)) ?? null));
  h.chain.readOnchainPlan.mockImplementation(async (contract: Address, id: bigint) => plans.get(planKey(contract, id)) ?? null);
  client.getBalance.mockResolvedValue(10n ** 16n);
  client.simulateContract.mockImplementation(async (args: Record<string, unknown>) => ({ request: args }));
  wallet.writeContract.mockImplementation(async (req: { address: Address; args: readonly [bigint, ReadonlyArray<{ amountIn: bigint }>] }) => {
    const hash = txHash(++hashes);
    sent.set(hash, req);
    return hash;
  });
  client.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hash }) => receiptFor(hash));
  trades.create.mockImplementation(async (t: unknown) => t);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------ switched off ------------------------------ */

describe("runDuePlans: a keeper that cannot run says why", () => {
  it("reports disabled without a deployment and reads nothing", async () => {
    h.deployed = false;
    const list = vi.spyOn(automation, "listAuto");
    const report = await runDuePlans({ now: NOW });
    expect(report).toMatchObject({ enabled: false, reason: expect.stringMatching(/NEXT_PUBLIC_AUTO_INVEST_ADDRESS/), checked: 0, executed: [], failed: [] });
    expect(client.getBalance).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("reports disabled without a keeper key", async () => {
    h.account = null;
    const report = await runDuePlans({ now: NOW });
    expect(report).toMatchObject({ enabled: false, reason: "AUTOMATION_KEEPER_KEY is not set" });
    expect(report.keeper).toBeUndefined();
    expect(client.getBalance).not.toHaveBeenCalled();
  });

  it("refuses to tick on a keeper too low on gas, naming the address to top up", async () => {
    client.getBalance.mockResolvedValue(10n ** 14n); // 0.0001 ETH, under the 0.0003 floor
    await seed(plan());
    const report = await runDuePlans({ now: NOW });
    expect(report).toMatchObject({ enabled: false, keeper: KEEPER.address, keeperEth: "0.00010" });
    expect(report.reason).toContain(KEEPER.address);
    expect(report.reason).toMatch(/top it up/);
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("an unreadable balance counts as empty, not as funded", async () => {
    client.getBalance.mockRejectedValue(new Error("rpc down"));
    const report = await runDuePlans({ now: NOW });
    expect(report.enabled).toBe(false);
    expect(report.keeperEth).toBe("0.00000");
  });

  it("executeRun without a keeper wallet records a failure instead of throwing", async () => {
    h.wallet = null;
    const p = plan();
    plans.set(planKey(p.contract, p.planId), p);
    const outcome = await executeRun(p, await buildRunSwaps(p));
    expect(outcome).toMatchObject({ ok: false, error: "No keeper is configured on this server.", retryAfterMs: HOUR });
    expect(client.simulateContract).not.toHaveBeenCalled();
  });
});

/* ------------------------------- a due plan ------------------------------- */

describe("runDuePlans: a due plan", () => {
  it("claims the plan, sends one execute built for the owner, records it, and releases the lock", async () => {
    await seed(plan());
    const claim = vi.spyOn(automation, "claimRun");
    let pendingWhileWaiting: unknown;
    client.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hash }) => {
      pendingWhileWaiting = (await stored("auto_7")).config.pendingRun;
      return receiptFor(hash);
    });

    const report = await runDuePlans({ now: NOW });

    expect(report).toMatchObject({ enabled: true, keeper: KEEPER.address, contracts: [V2, V1], checked: 1, failed: [], pending: [] });
    expect(report.executed).toEqual([{ ruleId: "auto_7", planId: "7", txHash: txHash(1), spentUsd: 50 }]);
    expect(claim).toHaveBeenCalledWith("auto_7", OWNER, expect.objectContaining({ runningSince: NOW }), null);
    // Taker is the contract that executes the swap, recipient the owner; never an order-book route.
    expect(h.quote).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", assetAddress: NVDA, sellAmount: 30_000_000n, taker: V2, recipient: OWNER, orders: false, noZeroX: true, slippageBps: 300 }));
    expect(h.quote).toHaveBeenCalledWith(expect.objectContaining({ assetAddress: AAPL, sellAmount: 20_000_000n }));
    expect(client.simulateContract).toHaveBeenCalledWith({
      address: V2,
      abi: autoInvestAbi,
      functionName: "execute",
      args: [
        7n,
        [
          { target: ROUTER, spender: SPENDER, amountIn: 30_000_000n, minOut: 97_000_000n, data: "0x1234" },
          { target: ROUTER, spender: SPENDER, amountIn: 20_000_000n, minOut: 97_000_000n, data: "0x1234" },
        ],
      ],
      account: KEEPER,
    });
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    // What was simulated is exactly what was signed.
    expect(wallet.writeContract).toHaveBeenCalledWith(client.simulateContract.mock.calls[0]![0]);

    // The hash was on the record before the receipt was awaited.
    expect(pendingWhileWaiting).toEqual({ txHash: txHash(1), at: NOW });

    const rule = await stored("auto_7");
    expect(rule.config.runningSince).toBeUndefined();
    expect(rule.config.pendingRun).toBeUndefined();
    expect(rule.config.lastError).toBeUndefined();
    expect(rule.config.history?.[0]).toMatchObject({ ok: true, via: "keeper", txHash: txHash(1), spentUsd: 50 });
    expect(rule.config.history?.[0]?.legs).toEqual([
      { assetAddress: NVDA, symbol: "NVDAc", spentUsd: 30, received: "60000000", provider: "kyber", skipped: undefined },
      { assetAddress: AAPL, symbol: "AAPLc", spentUsd: 20, received: "40000000", provider: "kyber", skipped: undefined },
    ]);
    expect(trades.create).toHaveBeenCalledTimes(2);
    expect(trades.create).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER, side: "buy", assetAddress: NVDA, sellAmount: "30000000", buyAmount: "60000000", usdValue: 30, txHash: txHash(1), status: "confirmed", verifiedAt: NOW }));
  });

  it("uses the higher of the route's minOut and the contract's floor as the leg's minimum", async () => {
    h.chain.readFloor.mockResolvedValue(99_000_000n); // above the route's 97M, below its 100M quote
    const p = plan();
    const built = await buildRunSwaps(p);
    expect(built.swaps.map((s) => s.minOut)).toEqual([99_000_000n, 99_000_000n]);
    expect(built.total).toBe(50_000_000n);
  });

  it("serves a legacy V1 plan at V1: quotes, simulates and sends against the plan's own contract", async () => {
    await seed(plan({ contract: V1, planId: 3n }));
    const report = await runDuePlans({ now: NOW });
    expect(report.executed).toHaveLength(1);
    expect(h.quote).toHaveBeenCalledWith(expect.objectContaining({ taker: V1 }));
    expect(h.chain.readRouteAllowed).toHaveBeenCalledWith(V1, ROUTER, SPENDER);
    expect(h.chain.readFloor).toHaveBeenCalledWith(V1, NVDA, 30_000_000n, 300);
    expect(client.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: V1 }));
  });

  it("leaves a mirror that names a contract it does not know alone", async () => {
    const stranger = "0x1111111111111111111111111111111111111111" as Address;
    await seed(plan({ contract: stranger }));
    const report = await runDuePlans({ now: NOW });
    expect(report.checked).toBe(1);
    expect(h.chain.readOnchainPlans).toHaveBeenCalledWith([]);
    expect(h.quote).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("walks every page of auto rules, not only the first hundred", async () => {
    for (let i = 1; i <= 101; i++) await seed(plan({ planId: BigInt(i), nextRunAt: SEC + 3600 }));
    const list = vi.spyOn(automation, "listAuto");
    const report = await runDuePlans({ now: NOW });
    expect(report.checked).toBe(101);
    expect(list.mock.calls).toEqual([
      [100, 0],
      [100, 100],
    ]);
  });
});

/* ----------------------------- not due / backed off ----------------------------- */

describe("runDuePlans: a plan that is not due is never sent", () => {
  it.each([
    ["scheduled later", plan({ nextRunAt: SEC + 3600 })],
    ["paused", plan({ status: "paused" })],
    ["cancelled", plan({ status: "cancelled" })],
    ["expired", plan({ expiry: SEC - 1 })],
  ])("%s", async (_label, p) => {
    await seed(p);
    const claim = vi.spyOn(automation, "claimRun");
    const report = await runDuePlans({ now: NOW });
    expect(report).toMatchObject({ checked: 1, executed: [], failed: [], pending: [] });
    expect(claim).not.toHaveBeenCalled();
    expect(h.quote).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("the contract's NotDue is recorded with a back-off, nothing is sent, and the lock is released", async () => {
    await seed(plan());
    client.simulateContract.mockRejectedValue(revert("NotDue"));
    const report = await runDuePlans({ now: NOW });
    expect(report.failed).toEqual([{ ruleId: "auto_7", planId: "7", error: "The next run is not due yet." }]);
    expect(wallet.writeContract).not.toHaveBeenCalled();
    const rule = await stored("auto_7");
    expect(rule.config.runningSince).toBeUndefined();
    expect(rule.config.lastError).toEqual({ at: NOW, message: "The next run is not due yet.", retryAt: NOW + HOUR });
    expect(rule.config.history?.[0]).toMatchObject({ ok: false, via: "keeper", error: "The next run is not due yet." });

    // Inside the back-off the next tick does not even try.
    client.simulateContract.mockClear();
    const next = await runDuePlans({ now: NOW + HOUR / 2 });
    expect(next.failed).toEqual([]);
    expect(client.simulateContract).not.toHaveBeenCalled();
  });

  it("a TransferFailed revert backs off for six hours, not one", async () => {
    await seed(plan());
    client.simulateContract.mockRejectedValue(revert("TransferFailed"));
    await runDuePlans({ now: NOW });
    expect((await stored("auto_7")).config.lastError?.retryAt).toBe(NOW + 6 * HOUR);
  });

  it.each([
    ["balance", { usdcBalance: "1000000", allowance: "1000000000", enough: false, runsCovered: 20 }, "Not enough USDC in the wallet for this run."],
    ["allowance", { usdcBalance: "1000000000", allowance: "1000000", enough: false, runsCovered: 0 }, "The USDC allowance no longer covers a run; approve more to continue."],
  ])("an underfunded plan (%s) is reported and backed off without a claim or a send", async (_label, funding, message) => {
    await seed(plan());
    h.chain.readFunding.mockResolvedValue(funding);
    const claim = vi.spyOn(automation, "claimRun");
    const report = await runDuePlans({ now: NOW });
    expect(report.failed).toEqual([{ ruleId: "auto_7", planId: "7", error: message }]);
    expect(claim).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
    const rule = await stored("auto_7");
    expect(rule.config.lastError).toEqual({ at: NOW, message, retryAt: NOW + 6 * HOUR });
    expect(rule.config.onchain?.funding).toEqual(funding);
  });
});

/* ---------------------------------- lock ---------------------------------- */

describe("runDuePlans: the run lock", () => {
  it("leaves a plan alone while another tick holds a fresh lock", async () => {
    await seed(plan(), { runningSince: NOW - 60_000 });
    const claim = vi.spyOn(automation, "claimRun");
    const report = await runDuePlans({ now: NOW });
    expect(report).toMatchObject({ checked: 1, executed: [], failed: [] });
    expect(claim).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("takes over a lock older than RUN_LOCK_MS, conditioned on the stale value it read", async () => {
    const stale = NOW - RUN_LOCK_MS - 1;
    await seed(plan(), { runningSince: stale });
    const claim = vi.spyOn(automation, "claimRun");
    const report = await runDuePlans({ now: NOW });
    expect(claim).toHaveBeenCalledWith("auto_7", OWNER, expect.objectContaining({ runningSince: NOW }), stale);
    expect(report.executed).toHaveLength(1);
  });

  it("sends nothing when the claim is lost or cannot be written", async () => {
    await seed(plan());
    const claim = vi.spyOn(automation, "claimRun").mockResolvedValueOnce(false);
    expect((await runDuePlans({ now: NOW })).executed).toEqual([]);
    claim.mockRejectedValueOnce(new Error("db down"));
    expect((await runDuePlans({ now: NOW })).executed).toEqual([]);
    expect(h.quote).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("lets only one of two overlapping ticks run the same plan", async () => {
    await seed(plan());
    const claim = vi.spyOn(automation, "claimRun");
    const [a, b] = await Promise.all([runDuePlans({ now: NOW }), runDuePlans({ now: NOW })]);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(a.executed.length + b.executed.length).toBe(1);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  /** Tick B reads the rule, then stalls on the chain read until tick A holds the lock. */
  async function overlapWithLateReader() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = async (refs: Array<{ contract: Address; planId: bigint }>) => refs.map((r) => plans.get(planKey(r.contract, r.planId)) ?? null);
    h.chain.readOnchainPlans.mockImplementationOnce(read).mockImplementationOnce(async (refs: Array<{ contract: Address; planId: bigint }>) => {
      await gate;
      return read(refs);
    });
    const real = automation.claimRun.bind(automation);
    vi.spyOn(automation, "claimRun").mockImplementationOnce(async (...args) => {
      const ok = await real(...args);
      release();
      return ok;
    });
    await Promise.all([runDuePlans({ now: NOW }), runDuePlans({ now: NOW })]);
  }

  it("holds against a late reader when the mirror is already in sync", async () => {
    await seed(plan());
    await overlapWithLateReader();
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  // Known bug: the mirror refresh (auto-invest-keeper.ts:384-385) writes back the whole config it
  // read before the other tick's claim, erasing `runningSince`, so the late tick's claim (expected
  // null) succeeds and both send. Remove `.fails` once the refresh leaves the lock fields alone.
  it.fails("holds against a late reader that also refreshes a stale mirror", async () => {
    const p = plan();
    await seed(p, { onchain: { ...mirror(p), runs: 2 } });
    await overlapWithLateReader();
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  });
});

/* --------------------------- pending, sent runs --------------------------- */

describe("runDuePlans: a run sent but not yet mined", () => {
  const PENDING = txHash(0xabc);

  it("stays locked with its hash on record when the receipt does not arrive in time", async () => {
    await seed(plan());
    client.waitForTransactionReceipt.mockRejectedValue(new Error("timed out"));
    const report = await runDuePlans({ now: NOW });
    expect(report.pending).toEqual([{ ruleId: "auto_7", planId: "7", txHash: txHash(1), state: "sent" }]);
    expect(report.executed).toEqual([]);
    expect(report.failed).toEqual([]);
    const rule = await stored("auto_7");
    expect(rule.config.pendingRun).toEqual({ txHash: txHash(1), at: NOW });
    expect(rule.config.runningSince).toBe(NOW);
    expect(rule.config.history).toEqual([]);
    expect(trades.create).not.toHaveBeenCalled();
  });

  it("a failed pendingRun write does not stop the run from being waited for and recorded", async () => {
    await seed(plan());
    const update = vi.spyOn(automation, "update").mockRejectedValueOnce(new Error("db blip"));
    const report = await runDuePlans({ now: NOW });
    expect(update).toHaveBeenCalled();
    expect(report.executed).toHaveLength(1);
  });

  it("is recorded from the chain on the next tick, without sending again", async () => {
    const p = plan();
    sent.set(PENDING, { address: p.contract, args: [p.planId, [{ amountIn: 30_000_000n }, { amountIn: 20_000_000n }]] });
    await seed(p, { runningSince: NOW - 60_000, pendingRun: { txHash: PENDING, at: NOW - 60_000 } });
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hash }) => receiptFor(hash));

    const report = await runDuePlans({ now: NOW });

    expect(report.pending).toEqual([{ ruleId: "auto_7", planId: "7", txHash: PENDING, state: "recorded" }]);
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
    const rule = await stored("auto_7");
    expect(rule.config.pendingRun).toBeUndefined();
    expect(rule.config.runningSince).toBeUndefined();
    expect(rule.config.history?.[0]).toMatchObject({ ok: true, via: "keeper", txHash: PENDING, spentUsd: 50 });
    expect(trades.create).toHaveBeenCalledTimes(2);
  });

  it("waits through the grace window, then writes the run off and frees the plan", async () => {
    await seed(plan(), { runningSince: NOW, pendingRun: { txHash: PENDING, at: NOW } });
    client.getTransactionReceipt.mockRejectedValue(new Error("TransactionReceiptNotFoundError"));

    const early = await runDuePlans({ now: NOW + 2 * HOUR - 1 });
    expect(early.pending).toEqual([{ ruleId: "auto_7", planId: "7", txHash: PENDING, state: "waiting" }]);
    expect((await stored("auto_7")).config.pendingRun).toEqual({ txHash: PENDING, at: NOW });

    vi.setSystemTime(NOW + 2 * HOUR);
    const late = await runDuePlans({ now: NOW + 2 * HOUR });
    expect(late.pending).toEqual([{ ruleId: "auto_7", planId: "7", txHash: PENDING, state: "dropped" }]);
    const rule = await stored("auto_7");
    expect(rule.config.pendingRun).toBeUndefined();
    expect(rule.config.runningSince).toBeUndefined();
    expect(rule.config.history?.[0]).toMatchObject({ ok: false, txHash: PENDING, error: expect.stringMatching(/never mined/) });
    expect(rule.config.lastError?.retryAt).toBe(NOW + 3 * HOUR);
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expect(trades.create).not.toHaveBeenCalled();
  });

  it("records a mined but reverted pending run as a failure", async () => {
    const p = plan();
    sent.set(PENDING, { address: p.contract, args: [p.planId, [{ amountIn: 30_000_000n }, { amountIn: 20_000_000n }]] });
    await seed(p, { runningSince: NOW, pendingRun: { txHash: PENDING, at: NOW } });
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hash }) => receiptFor(hash, "reverted"));
    const report = await runDuePlans({ now: NOW });
    expect(report.pending[0]?.state).toBe("recorded");
    const rule = await stored("auto_7");
    expect(rule.config.history?.[0]).toMatchObject({ ok: false, error: "The run reverted onchain; no USDC moved." });
    expect(trades.create).not.toHaveBeenCalled();
  });
});

/* --------------------------------- the cap -------------------------------- */

describe("runDuePlans: the per-tick cap", () => {
  it("runs at most AUTOMATION_MAX_RUNS_PER_TICK plans and leaves the rest untouched", async () => {
    h.env.AUTOMATION_MAX_RUNS_PER_TICK = 2;
    for (const id of [1n, 2n, 3n]) await seed(plan({ planId: id }));
    const report = await runDuePlans({ now: NOW });
    expect(report.executed.map((e) => e.planId)).toEqual(["1", "2"]);
    expect(wallet.writeContract).toHaveBeenCalledTimes(2);
    const third = await stored("auto_3");
    expect(third.config.history).toEqual([]);
    expect(third.config.runningSince).toBeUndefined();
  });

  it("an explicit limit overrides the environment, and failures count toward it", async () => {
    for (const id of [1n, 2n]) await seed(plan({ planId: id }));
    client.simulateContract.mockRejectedValue(revert("NotDue"));
    const report = await runDuePlans({ now: NOW, limit: 1 });
    expect(report.failed).toHaveLength(1);
    expect(client.simulateContract).toHaveBeenCalledTimes(1);
  });

  // Known bug: a run that went out but was not mined in time is pushed to `pending`, which the cap
  // check (auto-invest-keeper.ts:378 and :434) does not count, so a tick with slow receipts sends
  // every due plan. Remove `.fails` once sent-but-pending runs count toward the limit.
  it.fails("counts a sent but unmined run toward the cap", async () => {
    h.env.AUTOMATION_MAX_RUNS_PER_TICK = 1;
    for (const id of [1n, 2n]) await seed(plan({ planId: id }));
    client.waitForTransactionReceipt.mockRejectedValue(new Error("timed out"));
    await runDuePlans({ now: NOW });
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------- leg checks ------------------------------- */

describe("buildRunSwaps and the tick: legs that must not run are skipped, not sent", () => {
  it("skips a leg whose reference floor is unavailable when the stock has a feed", async () => {
    h.chain.readFloor.mockImplementation(async (_c: Address, a: Address) => (a === AAPL ? 0n : 95_000_000n));
    const built = await buildRunSwaps(plan());
    expect(built.total).toBe(30_000_000n);
    expect(built.swaps[1]).toEqual({ target: ZERO, spender: ZERO, amountIn: 0n, minOut: 0n, data: "0x" });
    expect(built.legs[1]).toMatchObject({ symbol: "AAPLc", amountIn: 0n, skipped: expect.stringMatching(/reference floor is unavailable/) });
  });

  it("treats a floor that cannot be read like an unavailable one", async () => {
    h.chain.readFloor.mockRejectedValue(new Error("rpc"));
    const built = await buildRunSwaps(plan());
    expect(built.total).toBe(0n);
    expect(built.legs.every((l) => /reference floor is unavailable/.test(l.skipped ?? ""))).toBe(true);
  });

  it("never runs a stock without a feed on the route's own minimum", async () => {
    h.getAssets.mockResolvedValue([asset(NVDA, "NVDAc", { oracle: undefined }), asset(AAPL, "AAPLc")]);
    h.chain.readFloor.mockResolvedValue(0n);
    const built = await buildRunSwaps(plan());
    expect(built.total).toBe(0n);
    expect(built.swaps[0]).toEqual({ target: ZERO, spender: ZERO, amountIn: 0n, minOut: 0n, data: "0x" });
    expect(built.legs[0]?.skipped).toMatch(/no Chainlink reference/);
    expect(built.legs[1]?.skipped).toMatch(/reference floor is unavailable/);
  });

  it("buys the stocks that have a floor and skips the one without a feed", async () => {
    h.getAssets.mockResolvedValue([asset(NVDA, "NVDAc", { oracle: undefined }), asset(AAPL, "AAPLc")]);
    h.chain.readFloor.mockImplementation(async (_c: Address, a: Address) => (a === NVDA ? 0n : 95_000_000n));
    const built = await buildRunSwaps(plan());
    expect(built.legs[0]?.skipped).toMatch(/no Chainlink reference/);
    expect(built.legs[1]?.skipped).toBeUndefined();
    expect(built.total).toBe(20_000_000n);
  });

  it("skips a leg whose pool quotes under the contract's floor", async () => {
    h.chain.readFloor.mockImplementation(async (_c: Address, a: Address) => (a === NVDA ? 150_000_000n : 95_000_000n));
    const built = await buildRunSwaps(plan());
    expect(built.legs[0]?.skipped).toBe("pool price is further from the Chainlink reference than the plan allows");
    expect(built.swaps[0]?.amountIn).toBe(0n);
    expect(built.total).toBe(20_000_000n);
  });

  it.each([
    ["not active", [asset(NVDA, "NVDAc", { status: "paused" }), asset(AAPL, "AAPLc")], /not a tradable stock/],
    ["unknown", [asset(AAPL, "AAPLc")], /not a tradable stock/],
    ["not issued", [asset(NVDA, "NVDAc", { totalSupply: 0n }), asset(AAPL, "AAPLc")], /not issued/],
  ])("skips a leg whose stock is %s", async (_label, assets, why) => {
    h.getAssets.mockResolvedValue(assets);
    const built = await buildRunSwaps(plan());
    expect(built.legs[0]?.skipped).toMatch(why);
    expect(built.total).toBe(20_000_000n);
  });

  it("skips a leg under the per-leg minimum", async () => {
    const built = await buildRunSwaps(plan({ amountPerRun: 2_000_000n })); // $1.20 / $0.80
    expect(built.legs[0]?.skipped).toBeUndefined();
    expect(built.legs[1]?.skipped).toMatch(/per-leg minimum/);
  });

  it("with every leg skipped the tick sends nothing and records why", async () => {
    await seed(plan());
    h.chain.readFloor.mockResolvedValue(150_000_000n);
    const report = await runDuePlans({ now: NOW });
    expect(client.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expect(report.failed[0]?.error).toBe("NVDAc: pool price is further from the Chainlink reference than the plan allows; AAPLc: pool price is further from the Chainlink reference than the plan allows");
    const rule = await stored("auto_7");
    expect(rule.config.runningSince).toBeUndefined();
    expect(rule.config.lastError?.retryAt).toBe(NOW + HOUR);
  });

  it("drops the leg the contract says delivers too little, once, and sends the rest", async () => {
    await seed(plan());
    client.simulateContract.mockRejectedValueOnce(revert("TooLittleReceived", [1n, 5n, 10n]));
    const report = await runDuePlans({ now: NOW });
    expect(client.simulateContract).toHaveBeenCalledTimes(2);
    const retried = client.simulateContract.mock.calls[1]![0] as { args: [bigint, Array<{ amountIn: bigint }>] };
    expect(retried.args[1].map((s) => s.amountIn)).toEqual([30_000_000n, 0n]);
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
    expect(report.executed).toHaveLength(1);
    const legs = (await stored("auto_7")).config.history?.[0]?.legs;
    expect(legs?.[1]).toMatchObject({ assetAddress: AAPL, spentUsd: 0, skipped: "the route delivered less than the plan allows" });
    expect(trades.create).toHaveBeenCalledTimes(1);
  });

  it("walks the fallback providers when the best route is not on the allow-list", async () => {
    h.quote.mockImplementation(async (req: { provider?: string }) => (req.provider ? allowedQuote(req) : { ...allowedQuote({ provider: "okx" }), transaction: { to: OKX_ROUTER, data: "0x99", value: "0" } }));
    h.chain.readRouteAllowed.mockImplementation(async (_c: Address, target: Address) => ({ router: target !== OKX_ROUTER, spender: true }));
    const built = await buildRunSwaps(plan({ legs: [{ asset: NVDA, weightBps: 10_000 }] }));
    expect(built.legs[0]).toMatchObject({ provider: "kyber", expectedOut: 100_000_000n });
    expect(built.swaps[0]?.target).toBe(ROUTER);
    expect(h.quote).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: "kyber", strictProvider: true }));
  });

  it("refuses a route that pays in ETH or names no spender, and says the last reason when none is left", async () => {
    h.quote.mockImplementation(async (req: { provider?: string }) => {
      if (!req.provider) return { ...allowedQuote({ provider: "okx" }), transaction: { to: ROUTER, data: "0x", value: "1" } };
      if (req.provider === "kyber") return { ...allowedQuote(req), allowanceSpender: undefined };
      throw new Error(`${req.provider} has no route`);
    });
    const built = await buildRunSwaps(plan({ legs: [{ asset: NVDA, weightBps: 10_000 }] }));
    expect(built.total).toBe(0n);
    expect(built.legs[0]?.skipped).toBe("aerodrome has no route");
    expect(h.quote.mock.calls.map((c) => (c[0] as { provider?: string }).provider)).toEqual([undefined, "kyber", "velora", "aerodrome"]);
  });
});

/* ---------------------- isolation between plans, secrets ---------------------- */

describe("runDuePlans: one plan's failure is its own", () => {
  it("a plan that fails to send does not stop the next, and no report or record carries the key", async () => {
    await seed(plan({ planId: 1n }));
    await seed(plan({ planId: 2n }));
    wallet.writeContract.mockRejectedValueOnce(new Error("nonce too low\nRequest Arguments: from: 0x…"));

    const report = await runDuePlans({ now: NOW });

    expect(report.failed).toEqual([{ ruleId: "auto_1", planId: "1", error: "Could not send the run: nonce too low" }]);
    expect(report.executed.map((e) => e.planId)).toEqual(["2"]);
    const first = await stored("auto_1");
    expect(first.config.runningSince).toBeUndefined();
    expect(first.config.lastError?.message).toBe("Could not send the run: nonce too low");

    const everything = JSON.stringify([report, await automation.listAll(), trades.create.mock.calls], (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
    expect(everything).not.toContain(KEY.slice(2).toLowerCase());
  });

  it("a simulation error that is not the contract's is recorded by its first line", async () => {
    await seed(plan());
    client.simulateContract.mockRejectedValue(new Error("HTTP request failed.\nURL: https://rpc.example\nRequest body: {…}"));
    const report = await runDuePlans({ now: NOW });
    expect(report.failed[0]?.error).toBe("HTTP request failed.");
  });

  // Known bug: `buildRunSwaps` (auto-invest-keeper.ts:418) is not guarded, so a rejection from
  // `getAssets` or `getPriceViews` for one plan throws out of the whole tick after that plan was
  // claimed: later plans are not run and the claimed one stays locked until RUN_LOCK_MS passes.
  it.fails("a plan whose swaps cannot be built does not stop the next one", async () => {
    await seed(plan({ planId: 1n }));
    await seed(plan({ planId: 2n }));
    h.getAssets.mockRejectedValueOnce(new Error("multicall failed"));
    const report = await runDuePlans({ now: NOW });
    expect(report.executed.map((e) => e.planId)).toEqual(["2"]);
  });
});

/* -------------------------- runs the owner sent -------------------------- */

describe("outcomeFromReceipt", () => {
  const TX = txHash(0xbeef);
  const p = plan();

  it("reads only this plan's events from this plan's contract", async () => {
    client.getTransactionReceipt.mockResolvedValue({
      status: "success",
      to: V2,
      logs: [
        legFilled(ROUTER, 7n, NVDA, 1n, 999_999_999n), // a router emitting a same-shaped event
        legFilled(V2, 8n, NVDA, 5_000_000n, 1n), // another plan in the same run
        legFilled(V2, 7n, NVDA, 30_000_000n, 60_000_000n),
        legSkipped(V2, 7n, AAPL),
        planExecuted(V2, 7n, 30_000_000n),
      ],
    });
    h.getAssets.mockResolvedValue([asset(NVDA, "NVDAc"), asset(AAPL, "AAPLc")]);
    const outcome = await outcomeFromReceipt(p, TX, new Map([[AAPL.toLowerCase(), "pool too thin"]]));
    expect(outcome).toEqual({
      ok: true,
      txHash: TX,
      spentUsd: 30,
      legs: [
        { assetAddress: NVDA, symbol: "NVDAc", spentUsd: 30, received: "60000000" },
        { assetAddress: AAPL, symbol: "AAPLc", spentUsd: 0, skipped: "pool too thin" },
      ],
    });
  });

  it("refuses a transaction to another AutoInvest deployment", async () => {
    client.getTransactionReceipt.mockResolvedValue({ status: "success", to: V1, logs: [planExecuted(V1, 7n, 1n)] });
    await expect(outcomeFromReceipt(p, TX)).rejects.toThrow(/did not call this plan's AutoInvest contract/);
  });

  it("refuses a transaction that did not run this plan", async () => {
    client.getTransactionReceipt.mockResolvedValue({ status: "success", to: V2, logs: [planExecuted(V2, 8n, 1n)] });
    await expect(outcomeFromReceipt(p, TX)).rejects.toThrow(/did not run this plan/);
  });

  it("a reverted run moved nothing", async () => {
    client.getTransactionReceipt.mockResolvedValue({ status: "reverted", to: V2, logs: [] });
    expect(await outcomeFromReceipt(p, TX)).toEqual({ ok: false, txHash: TX, legs: [], error: "The run reverted onchain; no USDC moved." });
  });
});

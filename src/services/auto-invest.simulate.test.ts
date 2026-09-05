import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPublicClient, decodeEventLog, decodeErrorResult, encodeDeployData, encodeFunctionData, erc20Abi, formatUnits, getContractAddress, hexToBigInt, http, numberToHex, parseAbi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { USDC_ADDRESS } from "@/config/chain";
import { autoInvestAbi } from "@/lib/auto-invest";

/**
 * End-to-end dry run of AutoInvest against Base mainnet state, without a single real transaction.
 *
 * B20 stocks are native precompiles, so a local fork (anvil) cannot execute them; `eth_simulateV1`
 * on a real Base node can. One simulated block does everything a real deployment would: deploy the
 * contract, register the NVDA feed, fund the owner with USDC (a whale's transfer, simulated),
 * approve, create a weekly plan, and run it with live aggregator calldata — then reads the owner's
 * NVDAc balance before and after and checks the contract's own reference floor.
 *
 * Opt-in: `SIMULATE_MAINNET=1 BASE_RPC_URL=… OWNER=0x… pnpm vitest run src/services/auto-invest.simulate.test.ts`
 */
const enabled = process.env.SIMULATE_MAINNET === "1" && !!process.env.BASE_RPC_URL;

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C" as Address;
const RUN_USD = 25;
const AMOUNT_PER_RUN = 25_000_000n;
const SLIPPAGE_BPS = 300;
/** Large USDC holders on Base (contracts): the biggest one lends the owner USDC inside the simulation. */
const USDC_HOLDERS: Address[] = [
  "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", // Aave v3 aBasUSDC
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue
  "0xb125E6687d4313864e53df431d5425969c15Eb2F", // Compound v3 cUSDCv3
  "0xd0b53D9277642d899DF5C87A3966A349A798F224", // Uniswap v3 WETH/USDC
];

type SimCall = { from?: Address; to?: Address; data?: Hex; value?: Hex; gas?: Hex };
type SimResult = Array<{ calls: Array<{ status: Hex; returnData: Hex; gasUsed: Hex; logs?: Array<{ address: Address; topics: Hex[]; data: Hex }>; error?: { code: number; message: string; data?: Hex } }> }>;

describe.skipIf(!enabled)("AutoInvest on Base mainnet state (eth_simulateV1, no real transaction)", () => {
  it("deploys, funds, plans and runs a $25 NVDA purchase in one simulated block", { timeout: 180_000 }, async () => {
    const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL!, { timeout: 60_000 }) });
    const owner = (process.env.OWNER ?? privateKeyToAccount(generatePrivateKey()).address) as Address;
    const deployer = privateKeyToAccount(generatePrivateKey()).address;
    // With AUTO_INVEST_DEPLOYED set, the real contract is exercised instead of a simulated deployment:
    // its own keeper runs the plan and its registered feeds set the floor.
    const deployed = process.env.AUTO_INVEST_DEPLOYED as Address | undefined;
    const contract = deployed ?? getContractAddress({ from: deployer, nonce: 0n });
    const keeper = deployed ? ((await client.readContract({ address: deployed, abi: autoInvestAbi, functionName: "keeper" })) as Address) : privateKeyToAccount(generatePrivateKey()).address;
    const planId = deployed ? ((await client.readContract({ address: deployed, abi: autoInvestAbi, functionName: "planCount" })) as bigint) + 1n : 1n;

    // Live quote with the yet-to-exist contract as taker and the owner as recipient — exactly what the keeper will build.
    const { tradeRouter } = await import("./trade-router");
    const { getAssets } = await import("./b20-asset-service");
    const quote = await tradeRouter.quote({ side: "buy", assetAddress: NVDA, sellAmount: AMOUNT_PER_RUN, taker: contract, recipient: owner, orders: false, noZeroX: true, slippageBps: SLIPPAGE_BPS, chainId: base.id });
    expect(quote.transaction).toBeTruthy();
    expect(quote.transaction!.value).toBe("0");
    const router = quote.transaction!.to;
    const spender = quote.allowanceSpender!;
    const minOut = quote.minBuyAmount ? BigInt(quote.minBuyAmount) : (BigInt(quote.buyAmount) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    const feed = (await getAssets()).find((a) => a.canonicalId === NVDA.toLowerCase())?.oracle?.feed;

    // The richest known USDC holder lends the owner one run's worth inside the simulation.
    const balances = await client.multicall({ allowFailure: false, contracts: USDC_HOLDERS.map((h) => ({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf" as const, args: [h] as const })) });
    const whale = USDC_HOLDERS[balances.indexOf(balances.reduce((a, b) => (a > b ? a : b)))]!;

    const artifact = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/out/AutoInvest.sol/AutoInvest.json"), "utf8")) as { bytecode: { object: Hex } };
    const deploy = encodeDeployData({ abi: autoInvestAbi, bytecode: artifact.bytecode.object, args: [USDC_ADDRESS, keeper, [router], [spender]] });
    const b20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const gas = numberToHex(20_000_000n);

    const swap = { target: router, spender, amountIn: AMOUNT_PER_RUN, minOut, data: quote.transaction!.data };
    const named: Array<[string, SimCall]> = [
      ["before", { from: owner, to: NVDA, data: encodeFunctionData({ abi: b20, functionName: "balanceOf", args: [owner] }), gas }],
      ["usdcBefore", { from: owner, to: USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }), gas }],
      ...(deployed ? [] : ([["deploy", { from: deployer, data: deploy, gas }]] as Array<[string, SimCall]>)),
      ...(deployed || !feed ? [] : ([["feed", { from: deployer, to: contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "setFeed", args: [NVDA, feed] }), gas }]] as Array<[string, SimCall]>)),
      ["fund", { from: whale, to: USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [owner, AMOUNT_PER_RUN * 4n] }), gas }],
      ["approve", { from: owner, to: USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, AMOUNT_PER_RUN * 4n] }), gas }],
      ["create", { from: owner, to: contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "createPlan", args: [[NVDA], [10_000], AMOUNT_PER_RUN, 7 * 86_400, 0, 0, SLIPPAGE_BPS] }), gas }],
      ["floor", { from: keeper, to: contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "quoteFloor", args: [NVDA, AMOUNT_PER_RUN, SLIPPAGE_BPS] }), gas }],
      ["execute", { from: keeper, to: contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "execute", args: [planId, [swap]] }), gas }],
      ["after", { from: owner, to: NVDA, data: encodeFunctionData({ abi: b20, functionName: "balanceOf", args: [owner] }), gas }],
      ["usdcAfter", { from: owner, to: USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }), gas }],
      ["plan", { from: keeper, to: contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "plans", args: [planId] }), gas }],
      // A second run inside the cadence must be refused.
      ["again", { from: keeper, to: contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "execute", args: [planId, [swap]] }), gas }],
    ];
    const eth = numberToHex(10n ** 18n);
    const result = (await client.request({
      method: "eth_simulateV1" as never,
      params: [{ blockStateCalls: [{ stateOverrides: { [deployer]: { balance: eth }, [owner]: { balance: eth }, [keeper]: { balance: eth }, [whale]: { balance: eth } }, calls: named.map(([, c]) => c) }], validation: false, traceTransfers: false }, "latest"] as never,
    })) as SimResult;
    const out = result[0]!.calls;
    const at = (name: string) => out[named.findIndex(([n]) => n === name)]!;
    const explain = (name: string) => {
      const c = at(name);
      if (c.status === "0x1") return "ok";
      try {
        const d = decodeErrorResult({ abi: autoInvestAbi, data: c.error?.data ?? c.returnData });
        return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
      } catch {
        return c.error?.message ?? c.returnData;
      }
    };
    for (const [name] of named) if (name !== "again") expect(explain(name), `${name} failed: ${explain(name)}`).toBe("ok");

    const before = hexToBigInt(at("before").returnData);
    const after = hexToBigInt(at("after").returnData);
    const received = after - before;
    const floor = hexToBigInt(at("floor").returnData);
    const spent = hexToBigInt(at("usdcBefore").returnData) + AMOUNT_PER_RUN * 4n - hexToBigInt(at("usdcAfter").returnData);
    const filled = at("execute").logs?.flatMap((l) => {
      try {
        const e = decodeEventLog({ abi: autoInvestAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return e.eventName === "LegFilled" || e.eventName === "PlanExecuted" ? [e] : [];
      } catch {
        return [];
      }
    }) ?? [];
    const legFilled = filled.find((e) => e.eventName === "LegFilled");
    const planExecuted = filled.find((e) => e.eventName === "PlanExecuted");

    expect(received).toBeGreaterThan(0n);
    expect(received).toBeGreaterThanOrEqual(minOut);
    if (floor > 0n) expect(received).toBeGreaterThanOrEqual(floor);
    expect(legFilled).toBeTruthy();
    expect(planExecuted).toBeTruthy();
    expect(spent).toBe(AMOUNT_PER_RUN);
    expect(explain("again")).toBe("NotDue()");

    const perShareRef = quote.executablePricePerShareUsd;
    console.log(
      [
        `contract (${deployed ? "deployed, plan #" + planId : "simulated"}) ${contract}`,
        `owner ${owner} · keeper ${keeper} · whale ${whale}`,
        `route ${quote.provider} → ${router} (spender ${spender})`,
        `quote: ${formatUnits(BigInt(quote.buyAmount), 8)} NVDAc for $${RUN_USD} · minOut ${formatUnits(minOut, 8)} · exec ≈ $${quote.executablePriceUsd?.toFixed(2)}/token${perShareRef ? ` ($${perShareRef.toFixed(2)}/share)` : ""}`,
        `floor from Chainlink (−${SLIPPAGE_BPS / 100}%): ${formatUnits(floor, 8)} NVDAc${feed ? ` (feed ${feed})` : " (no feed)"}`,
        `received: ${formatUnits(received, 8)} NVDAc · USDC spent ${formatUnits(spent, 6)} · gas for execute ${Number(hexToBigInt(at("execute").gasUsed)).toLocaleString()}`,
        `second run inside the week: ${explain("again")}`,
      ].join("\n"),
    );
  });
});

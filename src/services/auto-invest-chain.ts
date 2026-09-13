import { erc20Abi, type Address } from "viem";
import { USDC_ADDRESS } from "@/config/chain";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { AUTO_INVEST_ADDRESS, autoInvestAbi, assessFunding, decodePlan, isAutoInvestDeployed, type OnchainPlan, type PlanFunding, type PlanTuple } from "@/lib/auto-invest";

/**
 * Read side of the AutoInvest contract, shared by the API (mirrors for the UI) and the keeper.
 * Every function here is a view; nothing in this module can sign or send.
 */

function contract(): Address {
  if (!isAutoInvestDeployed()) throw new Error("AutoInvest is not deployed here");
  return AUTO_INVEST_ADDRESS as Address;
}

export async function readOnchainPlan(planId: bigint): Promise<OnchainPlan | null> {
  const client = getServerPublicClient();
  const address = contract();
  const [plan, legs] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address, abi: autoInvestAbi, functionName: "plans", args: [planId] },
      { address, abi: autoInvestAbi, functionName: "legsOf", args: [planId] },
    ],
  });
  const tuple = plan as unknown as PlanTuple;
  if (tuple[0].toLowerCase() === "0x0000000000000000000000000000000000000000") return null;
  return decodePlan(planId, tuple, legs as ReadonlyArray<{ asset: Address; weightBps: number }>);
}

/** Several plans by id in one multicall; a plan that does not exist comes back null in its slot. */
export async function readOnchainPlans(planIds: readonly bigint[]): Promise<Array<OnchainPlan | null>> {
  if (planIds.length === 0) return [];
  const client = getServerPublicClient();
  const address = contract();
  const results = await client.multicall({
    allowFailure: true,
    contracts: planIds.flatMap((id) => [
      { address, abi: autoInvestAbi, functionName: "plans" as const, args: [id] as const },
      { address, abi: autoInvestAbi, functionName: "legsOf" as const, args: [id] as const },
    ]),
  });
  return planIds.map((id, i) => {
    const plan = results[i * 2];
    const legs = results[i * 2 + 1];
    if (plan?.status !== "success" || legs?.status !== "success") return null;
    const tuple = plan.result as unknown as PlanTuple;
    if (tuple[0].toLowerCase() === "0x0000000000000000000000000000000000000000") return null;
    return decodePlan(id, tuple, legs.result as ReadonlyArray<{ asset: Address; weightBps: number }>);
  });
}

export async function readOnchainPlansOf(owner: Address): Promise<OnchainPlan[]> {
  const client = getServerPublicClient();
  const address = contract();
  const ids = (await client.readContract({ address, abi: autoInvestAbi, functionName: "plansOf", args: [owner] })) as readonly bigint[];
  if (ids.length === 0) return [];
  const results = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((id) => [
      { address, abi: autoInvestAbi, functionName: "plans" as const, args: [id] as const },
      { address, abi: autoInvestAbi, functionName: "legsOf" as const, args: [id] as const },
    ]),
  });
  return ids.map((id, i) => decodePlan(id, results[i * 2] as unknown as PlanTuple, results[i * 2 + 1] as ReadonlyArray<{ asset: Address; weightBps: number }>));
}

/** USDC balance and allowance to the contract, judged against one run. */
export async function readFunding(owner: Address, amountPerRun: bigint): Promise<PlanFunding> {
  const client = getServerPublicClient();
  const address = contract();
  const [balance, allowance] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [owner, address] },
    ],
  });
  return assessFunding(balance as bigint, allowance as bigint, amountPerRun);
}

/** Funding for several (owner, amount) pairs in one multicall, in the order asked. */
export async function readFundingMany(items: ReadonlyArray<{ owner: Address; amountPerRun: bigint }>): Promise<PlanFunding[]> {
  if (items.length === 0) return [];
  const client = getServerPublicClient();
  const address = contract();
  const results = await client.multicall({
    allowFailure: false,
    contracts: items.flatMap((it) => [
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf" as const, args: [it.owner] as const },
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance" as const, args: [it.owner, address] as const },
    ]),
  });
  return items.map((it, i) => assessFunding(results[i * 2] as bigint, results[i * 2 + 1] as bigint, it.amountPerRun));
}

/** Whether a quote's router and approval target are on the contract's allow-list. */
export async function readRouteAllowed(target: Address, spender: Address): Promise<{ router: boolean; spender: boolean }> {
  const client = getServerPublicClient();
  const address = contract();
  const [router, sp] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address, abi: autoInvestAbi, functionName: "routerAllowed", args: [target] },
      { address, abi: autoInvestAbi, functionName: "spenderAllowed", args: [spender] },
    ],
  });
  return { router: router as boolean, spender: sp as boolean };
}

/** The contract's own reference floor for a leg (0 = no usable feed). */
export async function readFloor(asset: Address, amountIn: bigint, maxSlippageBps: number): Promise<bigint> {
  const client = getServerPublicClient();
  return (await client.readContract({ address: contract(), abi: autoInvestAbi, functionName: "quoteFloor", args: [asset, amountIn, maxSlippageBps] })) as bigint;
}

export async function readKeeper(): Promise<Address> {
  const client = getServerPublicClient();
  return (await client.readContract({ address: contract(), abi: autoInvestAbi, functionName: "keeper" })) as Address;
}

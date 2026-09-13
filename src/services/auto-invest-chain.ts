import { erc20Abi, type Address } from "viem";
import { USDC_ADDRESS } from "@/config/chain";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { AUTO_INVEST_ADDRESS, autoInvestAbi, assessFunding, decodePlan, isAutoInvestDeployed, type OnchainPlan, type PlanFunding, type PlanTuple } from "@/lib/auto-invest";

/**
 * Read side of the AutoInvest contracts, shared by the API (mirrors for the UI) and the keeper.
 * Every function here is a view; nothing in this module can sign or send.
 *
 * Every read names the deployment it goes to. There is more than one: plans created before V2
 * live in the first contract and stay there, so "plan #3" means nothing without its contract, and
 * an allowance is granted to one spender, so funding is per contract too.
 */

/** A plan's address on the chain: the deployment it lives in and its id there. */
export interface PlanRef {
  contract: Address;
  planId: bigint;
}

const NOBODY = "0x0000000000000000000000000000000000000000";

/**
 * Reads stay off entirely while the feature is not enabled here, exactly as before there was a
 * second deployment: a preview without the env var should not go and read mainnet plans.
 */
function at(contract: Address): Address {
  if (!isAutoInvestDeployed()) throw new Error("AutoInvest is not deployed here");
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error(`Not a contract address: ${contract}`);
  return contract;
}

export async function readOnchainPlan(contract: Address, planId: bigint): Promise<OnchainPlan | null> {
  const client = getServerPublicClient();
  const address = at(contract);
  const [plan, legs] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address, abi: autoInvestAbi, functionName: "plans", args: [planId] },
      { address, abi: autoInvestAbi, functionName: "legsOf", args: [planId] },
    ],
  });
  const tuple = plan as unknown as PlanTuple;
  if (tuple[0].toLowerCase() === NOBODY) return null;
  return decodePlan(address, planId, tuple, legs as ReadonlyArray<{ asset: Address; weightBps: number }>);
}

/**
 * Several plans, possibly across deployments, in one multicall; a plan that does not exist (or a
 * deployment that does not answer) comes back null in its slot.
 */
export async function readOnchainPlans(refs: readonly PlanRef[]): Promise<Array<OnchainPlan | null>> {
  if (refs.length === 0) return [];
  const client = getServerPublicClient();
  const results = await client.multicall({
    allowFailure: true,
    contracts: refs.flatMap((ref) => [
      { address: at(ref.contract), abi: autoInvestAbi, functionName: "plans" as const, args: [ref.planId] as const },
      { address: at(ref.contract), abi: autoInvestAbi, functionName: "legsOf" as const, args: [ref.planId] as const },
    ]),
  });
  return refs.map((ref, i) => {
    const plan = results[i * 2];
    const legs = results[i * 2 + 1];
    if (plan?.status !== "success" || legs?.status !== "success") return null;
    const tuple = plan.result as unknown as PlanTuple;
    if (tuple[0].toLowerCase() === NOBODY) return null;
    return decodePlan(ref.contract, ref.planId, tuple, legs.result as ReadonlyArray<{ asset: Address; weightBps: number }>);
  });
}

/** Every plan a wallet owns in one deployment. */
export async function readOnchainPlansOf(contract: Address, owner: Address): Promise<OnchainPlan[]> {
  const client = getServerPublicClient();
  const address = at(contract);
  const ids = (await client.readContract({ address, abi: autoInvestAbi, functionName: "plansOf", args: [owner] })) as readonly bigint[];
  if (ids.length === 0) return [];
  const results = await client.multicall({
    allowFailure: false,
    contracts: ids.flatMap((id) => [
      { address, abi: autoInvestAbi, functionName: "plans" as const, args: [id] as const },
      { address, abi: autoInvestAbi, functionName: "legsOf" as const, args: [id] as const },
    ]),
  });
  return ids.map((id, i) => decodePlan(address, id, results[i * 2] as unknown as PlanTuple, results[i * 2 + 1] as ReadonlyArray<{ asset: Address; weightBps: number }>));
}

/** USDC balance and the allowance granted to this deployment, judged against one run. */
export async function readFunding(contract: Address, owner: Address, amountPerRun: bigint): Promise<PlanFunding> {
  const client = getServerPublicClient();
  const spender = at(contract);
  const [balance, allowance] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [owner, spender] },
    ],
  });
  return assessFunding(balance as bigint, allowance as bigint, amountPerRun);
}

/** Funding for several (contract, owner, amount) triples in one multicall, in the order asked. */
export async function readFundingMany(items: ReadonlyArray<{ contract: Address; owner: Address; amountPerRun: bigint }>): Promise<PlanFunding[]> {
  if (items.length === 0) return [];
  const client = getServerPublicClient();
  const results = await client.multicall({
    allowFailure: false,
    contracts: items.flatMap((it) => [
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf" as const, args: [it.owner] as const },
      { address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance" as const, args: [it.owner, at(it.contract)] as const },
    ]),
  });
  return items.map((it, i) => assessFunding(results[i * 2] as bigint, results[i * 2 + 1] as bigint, it.amountPerRun));
}

/** Whether a quote's router and approval target are on this deployment's allow-list (each has its own). */
export async function readRouteAllowed(contract: Address, target: Address, spender: Address): Promise<{ router: boolean; spender: boolean }> {
  const client = getServerPublicClient();
  const address = at(contract);
  const [router, sp] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address, abi: autoInvestAbi, functionName: "routerAllowed", args: [target] },
      { address, abi: autoInvestAbi, functionName: "spenderAllowed", args: [spender] },
    ],
  });
  return { router: router as boolean, spender: sp as boolean };
}

/** This deployment's own reference floor for a leg (0 = no usable feed). V1 and V2 compute it differently. */
export async function readFloor(contract: Address, asset: Address, amountIn: bigint, maxSlippageBps: number): Promise<bigint> {
  const client = getServerPublicClient();
  return (await client.readContract({ address: at(contract), abi: autoInvestAbi, functionName: "quoteFloor", args: [asset, amountIn, maxSlippageBps] })) as bigint;
}

export async function readKeeper(contract: Address = AUTO_INVEST_ADDRESS as Address): Promise<Address> {
  const client = getServerPublicClient();
  return (await client.readContract({ address: at(contract), abi: autoInvestAbi, functionName: "keeper" })) as Address;
}

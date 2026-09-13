"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { encodeFunctionData, erc20Abi, parseEventLogs, type Address, type Hash, type Hex } from "viem";
import { base } from "viem/chains";
import { BASE_CHAIN_ID, USDC_ADDRESS } from "@/config/chain";
import { publicEnv } from "@/config/env";
import type { Allocation } from "@/domain/portfolio";
import { USDC_ALLOCATION_KEY } from "@/domain/portfolio";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { AUTO_INVEST, AUTO_INVEST_ADDRESS, autoInvestAbi, autoInvestAddressOf, cadenceToInterval, decodeAutoInvestError, isAutoInvestDeployed, legsFromAllocations, swapFromDto, usdToUsdc } from "@/lib/auto-invest";
import { apiPatch, apiPost, ApiError, type PreparedRunResponse } from "@/lib/client-api";
import { humanizeError, TRADE_ERROR_COPY } from "@/lib/errors";
import { callAfterApproval, walletCapabilities } from "@/lib/trade/execute";
import { useAuth } from "./useAuth";
import { useAutomation } from "./useAutomation";

export type AutoInvestPhase = "idle" | "preparing" | "wallet" | "submitted" | "recording";

export interface CreatePlanInput {
  allocations: Allocation[];
  amountUsd: number;
  cadenceDays: number;
  /** Unix ms; null = no expiry. */
  expiryAt?: number | null;
  maxSlippageBps?: number;
  /** USDC to approve up front; the plan can spend at most this until you approve more. */
  approveUsd: number;
  basketName?: string;
}

/**
 * An existing plan, addressed fully: the mirror it belongs to, its id onchain, and the deployment
 * it lives in. Plans created before V2 live in the legacy contract and every action on them
 * (pause, edit, top up, run, cancel) has to go there; only *new* plans go to the current contract.
 */
export interface PlanRef {
  ruleId: string;
  planId: string;
  contract: Address;
}

/** The onchain reference of a mirrored rule, or null for a manual plan. Structural so the API DTO fits. */
export function planRefOf(rule: { id: string; config: { onchain?: { planId: string; contract?: string } } }): PlanRef | null {
  if (!rule.config.onchain) return null;
  return { ruleId: rule.id, planId: rule.config.onchain.planId, contract: autoInvestAddressOf(rule) };
}

interface Call {
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * The plan owner's side of AutoInvest: create (approve + create in one confirmation on Base
 * Account, two on a classic wallet), pause, resume, cancel, top up the allowance, or run a due plan
 * from the wallet when the keeper is absent or slow. Every action is a transaction the owner signs;
 * the app then tells the server so the mirror catches up.
 */
export function useAutoInvest() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const auth = useAuth();
  const { invalidate } = useAutomation();
  const [phase, setPhase] = useState<AutoInvestPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  /** The contract new plans are created in and approved for; existing plans carry their own (`PlanRef.contract`). */
  const current = AUTO_INVEST_ADDRESS as Address;

  const ready = () => {
    if (!isAutoInvestDeployed()) throw new ApiError("PROVIDER_UNAVAILABLE", "Auto-invest is not enabled on this deployment.", 503);
    if (!address || !walletClient || !publicClient) throw new ApiError("WALLET_NOT_CONNECTED", TRADE_ERROR_COPY.WALLET_NOT_CONNECTED, 400);
    if (chainId !== BASE_CHAIN_ID) throw new ApiError("WRONG_NETWORK", TRADE_ERROR_COPY.WRONG_NETWORK, 400);
    return { address, walletClient, publicClient };
  };

  /** Atomic batch when the wallet can, one transaction after another when it cannot. Returns the last hash. */
  const send = useCallback(
    async (calls: Call[], simulateLast = true): Promise<Hash> => {
      const ctx = ready();
      const { atomic, paymaster } = await walletCapabilities(ctx.walletClient, ctx.address);
      setPhase("wallet");
      if (atomic && calls.length > 1) {
        const { id } = await ctx.walletClient.sendCalls({
          account: ctx.address,
          chain: base,
          forceAtomic: true,
          calls: calls.map((c) => ({ to: c.to, data: withAttribution(c.data), value: c.value })),
          capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
        });
        setPhase("submitted");
        const result = await ctx.walletClient.waitForCallsStatus({ id, timeout: 240_000 });
        if (result.status === "failure") throw new Error("The batched transaction failed onchain.");
        const hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
        if (!hash) throw new Error("The wallet did not return a transaction hash.");
        return hash;
      }
      let last: Hash | undefined;
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i]!;
        const isLast = i === calls.length - 1;
        // A dry run before the final call catches a revert before gas is spent; earlier calls are approvals.
        if (isLast && simulateLast) await callAfterApproval(ctx.publicClient, ctx.address, { to: c.to, data: c.data, value: c.value }, calls.length > 1 ? 6 : 2);
        setPhase("wallet");
        last = await ctx.walletClient.sendTransaction({ account: ctx.address, chain: base, to: c.to, data: withAttribution(c.data), value: c.value });
        setPhase("submitted");
        await ctx.publicClient.waitForTransactionReceipt({ hash: last });
      }
      return last!;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, chainId, walletClient, publicClient],
  );

  const fail = (err: unknown): never => {
    const decoded = decodeAutoInvestError(err);
    const message = decoded?.message ?? (err instanceof ApiError ? err.message : humanizeError(err).message);
    setError(message);
    setPhase("idle");
    throw err;
  };

  /** Approve USDC (only if the allowance is short) and create the plan; then mirror it for the UI. */
  const createPlan = useCallback(
    async (input: CreatePlanInput): Promise<{ planId: string; txHash: Hash }> => {
      setError(null);
      try {
        const ctx = ready();
        setPhase("preparing");
        const { assets, weightsBps } = legsFromAllocations(input.allocations);
        if (assets.length === 0) throw new ApiError("BAD_REQUEST", "Add at least one stock to the plan.", 400);
        if (assets.length > AUTO_INVEST.MAX_LEGS) throw new ApiError("BAD_REQUEST", `A plan can hold at most ${AUTO_INVEST.MAX_LEGS} stocks.`, 400);
        const amountPerRun = usdToUsdc(input.amountUsd);
        const interval = cadenceToInterval(input.cadenceDays);
        const expiry = input.expiryAt ? Math.floor(input.expiryAt / 1000) : 0;
        const slippage = input.maxSlippageBps ?? AUTO_INVEST.DEFAULT_SLIPPAGE_BPS;
        const createData = encodeFunctionData({ abi: autoInvestAbi, functionName: "createPlan", args: [assets, weightsBps, amountPerRun, interval, 0, expiry, slippage] });

        const wanted = usdToUsdc(Math.max(input.approveUsd, input.amountUsd));
        // The allowance that matters is the one granted to the contract this plan is created in; an
        // allowance left on the legacy contract does not carry over.
        const allowance = await ctx.publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: "allowance", args: [ctx.address, current] });
        const calls: Call[] = [];
        if (allowance < wanted) calls.push({ to: USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [current, wanted] }) });
        calls.push({ to: current, data: createData });
        const txHash = await send(calls);

        setPhase("recording");
        const receipt = await ctx.publicClient.getTransactionReceipt({ hash: txHash });
        const created = parseEventLogs({ abi: autoInvestAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === current.toLowerCase()), eventName: "PlanCreated" }).find((e) => e.args.owner.toLowerCase() === ctx.address.toLowerCase());
        let planId = created?.args.planId;
        if (planId === undefined) {
          const ids = (await ctx.publicClient.readContract({ address: current, abi: autoInvestAbi, functionName: "plansOf", args: [ctx.address] })) as readonly bigint[];
          planId = ids[ids.length - 1];
        }
        if (planId === undefined) throw new Error("The plan was created but its id could not be read; reload the page.");

        await auth.ensureSignedIn().catch(() => undefined);
        const stocks = input.allocations.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
        await apiPost("/api/automation", {
          type: stocks.length === 1 ? "recurring-buy" : "recurring-basket",
          mode: "auto",
          onchainPlanId: planId.toString(),
          onchainContract: current,
          txHash,
          basketName: stocks.length === 1 ? undefined : input.basketName,
          assetAddress: stocks.length === 1 ? stocks[0]!.assetAddress : undefined,
          amountUsd: input.amountUsd,
          cadenceDays: input.cadenceDays,
        }).catch(() => undefined);
        await invalidate();
        setPhase("idle");
        return { planId: planId.toString(), txHash };
      } catch (err) {
        return fail(err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, current, auth.ensureSignedIn, invalidate],
  );

  const afterChainChange = useCallback(
    async (ruleId: string) => {
      setPhase("recording");
      await apiPatch("/api/automation", { id: ruleId, action: "sync" }).catch(() => undefined);
      await invalidate();
      setPhase("idle");
    },
    [invalidate],
  );

  const setActive = useCallback(
    async (plan: PlanRef, active: boolean) => {
      setError(null);
      try {
        await send([{ to: plan.contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "setPlanActive", args: [BigInt(plan.planId), active] }) }]);
        await afterChainChange(plan.ruleId);
      } catch (err) {
        fail(err);
      }
    },
    [send, afterChainChange],
  );

  const cancelPlan = useCallback(
    async (plan: PlanRef) => {
      setError(null);
      try {
        await send([{ to: plan.contract, data: encodeFunctionData({ abi: autoInvestAbi, functionName: "cancelPlan", args: [BigInt(plan.planId)] }) }]);
        await afterChainChange(plan.ruleId);
      } catch (err) {
        fail(err);
      }
    },
    [send, afterChainChange],
  );

  /** Change a plan's terms onchain; the legs stay as they are (that is a new plan). */
  const updatePlan = useCallback(
    async (plan: PlanRef, terms: { amountUsd: number; cadenceDays: number; expiryAt: number | null; maxSlippageBps: number }) => {
      setError(null);
      try {
        await send([
          {
            to: plan.contract,
            data: encodeFunctionData({
              abi: autoInvestAbi,
              functionName: "updatePlan",
              args: [BigInt(plan.planId), usdToUsdc(terms.amountUsd), cadenceToInterval(terms.cadenceDays), terms.expiryAt ? Math.floor(terms.expiryAt / 1000) : 0, terms.maxSlippageBps],
            }),
          },
        ]);
        await afterChainChange(plan.ruleId);
      } catch (err) {
        fail(err);
      }
    },
    [send, afterChainChange],
  );

  /**
   * Raise (or, with 0, revoke) the USDC allowance a contract may draw on. With a plan, the
   * allowance is the one its own deployment draws from; without one, the contract new plans use.
   */
  const setAllowance = useCallback(
    async (usd: number, plan?: PlanRef) => {
      setError(null);
      try {
        const spender = plan?.contract ?? current;
        await send([{ to: USDC_ADDRESS, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, usdToUsdc(usd)] }) }], false);
        if (plan) await afterChainChange(plan.ruleId);
        else {
          await invalidate();
          setPhase("idle");
        }
      } catch (err) {
        fail(err);
      }
    },
    [send, current, afterChainChange, invalidate],
  );

  /** Run a due plan from the owner's own wallet: the server builds the swaps, the owner signs `execute`. */
  const runNow = useCallback(
    async (plan: PlanRef): Promise<{ txHash: Hash; prepared: PreparedRunResponse }> => {
      setError(null);
      try {
        const ctx = ready();
        setPhase("preparing");
        await auth.ensureSignedIn();
        const prepared = await apiPost<PreparedRunResponse>("/api/automation/prepare-run", { id: plan.ruleId });
        if (BigInt(prepared.total) === 0n) throw new ApiError("ROUTE_UNAVAILABLE", `Nothing can be bought right now: ${prepared.legs.map((l) => `${l.symbol.replace(/c$/, "")} — ${l.skipped}`).join("; ")}`, 409);
        const swaps = prepared.swaps.map(swapFromDto);
        // The server built the swaps with the plan's own contract as taker; `execute` goes to the same one.
        const { request } = await ctx.publicClient.simulateContract({ address: plan.contract, abi: autoInvestAbi, functionName: "execute", args: [BigInt(prepared.planId), swaps], account: ctx.address });
        setPhase("wallet");
        const txHash = await ctx.walletClient.writeContract({ ...request, account: ctx.address, chain: base });
        setPhase("submitted");
        const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") throw new Error("The run reverted onchain; no USDC moved.");
        setPhase("recording");
        // The receipt says which legs were skipped, not why; the reasons came with the preparation.
        const skipped = prepared.legs.filter((l) => l.skipped).map((l) => ({ assetAddress: l.assetAddress, reason: l.skipped! }));
        await apiPatch("/api/automation", { id: plan.ruleId, action: "ran-onchain", txHash, skipped }).catch(() => undefined);
        await invalidate();
        setPhase("idle");
        return { txHash, prepared };
      } catch (err) {
        return fail(err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.ensureSignedIn, invalidate, address, chainId, walletClient, publicClient],
  );

  return {
    phase,
    error,
    clearError: () => setError(null),
    busy: phase !== "idle",
    createPlan,
    updatePlan,
    setActive,
    cancelPlan,
    setAllowance,
    runNow,
    deployed: isAutoInvestDeployed(),
    /** The contract new plans are created in. A plan's own contract is `planRefOf(rule).contract`. */
    contractAddress: isAutoInvestDeployed() ? current : null,
  };
}

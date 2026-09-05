"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { erc20Abi, type Address, type Hash } from "viem";
import { base } from "viem/chains";
import type { PortfolioExecution, PortfolioExecutionStep, PortfolioPlan } from "@/domain/portfolio";
import { apiPatch, apiPost, ApiError, type ExecutableQuoteDTO } from "@/lib/client-api";
import { createCustomExecution, createExecution, newId, resetFailedSteps, summarize, updateStep, type CustomLeg } from "@/lib/execution/portfolio-execution";
import { allowanceNeeds, approvalCalls, receiptForLeg, type Call, type QuotedLeg } from "@/lib/execution/batch-plan";
import { executeTrade, simulateBundle, waitForConfirmation, walletCapabilities } from "@/lib/trade/execute";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { humanizeError, TRADE_ERROR_COPY } from "@/lib/errors";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { useAuth } from "./useAuth";

type QuotedStep = QuotedLeg & { step: PortfolioExecutionStep; quote: ExecutableQuoteDTO };

/**
 * Multi-leg execution (spec §25, §26). A basket of buys is quoted up front, so the USDC approvals
 * it needs are known before anything is signed: one approval per route for the basket's total, not
 * one per stock. A wallet that batches (EIP-5792) then takes the approvals and every purchase in a
 * single confirmation; any other wallet confirms the approval once and then each purchase. Sells
 * and buys together (a rebalance) still run leg by leg, sells first, because a buy cannot be quoted
 * against USDC a sell has not produced yet.
 *
 * Nothing is rolled back: a failed leg never undoes completed legs, and the UI shows "3 of 4
 * completed" with a retry. `start` and `startLegs` resolve with the execution as it stands when the
 * last leg has settled, so a caller can tell what was actually bought.
 */
export function usePortfolioExecution() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  const auth = useAuth();
  const [execution, setExecution] = useState<PortfolioExecution | null>(null);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const latest = useRef<PortfolioExecution | null>(null);
  const persisted = useRef(false);

  const commit = useCallback((next: PortfolioExecution, persist = true) => {
    latest.current = next;
    setExecution(next);
    if (persist && persisted.current) void apiPatch(`/api/portfolio/executions/${next.id}`, { status: next.status, steps: next.steps }).catch(() => undefined);
  }, []);

  const fail = useCallback(
    (stepId: string, err: unknown) => {
      const h = err instanceof ApiError ? { code: err.code, message: err.message } : humanizeError(err);
      commit(updateStep(latest.current!, stepId, { status: "failed", errorCode: h.code, errorMessage: h.message }));
      return h.code;
    },
    [commit],
  );

  /** Leg by leg through the shared executor: fresh quote, approval if still needed, simulate, send. */
  const runLegByLeg = useCallback(
    async (steps: PortfolioExecutionStep[], prefetched?: Map<string, ExecutableQuoteDTO>) => {
      if (!address || !walletClient || !publicClient) return;
      for (const step of steps) {
        const live = latest.current!.steps.find((s) => s.id === step.id)!;
        if (live.status !== "pending" && live.status !== "quoted") continue;
        setCurrentStepId(step.id);
        const side = live.side ?? "buy";
        const amount = side === "sell" ? BigInt(live.sellAmount ?? "0") : BigInt(live.sellAmountUsdc);
        try {
          const result = await executeTrade(
            { address, chainId, walletClient, publicClient },
            { side, assetAddress: step.assetAddress, sellAmount: amount, usdValue: step.targetUsd, orders: false, prefetchedQuote: prefetched?.get(step.id) },
            {
              onState: (s) => {
                if (s === "GETTING_FIRM_QUOTE") commit(updateStep(latest.current!, step.id, { status: "quoted" }), false);
              },
              onQuote: (q) => commit(updateStep(latest.current!, step.id, { provider: q.provider }), false),
              onSubmitted: (hash) => commit(updateStep(latest.current!, step.id, { status: "submitted", txHash: hash })),
            },
          );
          if (result.txHash) {
            commit(updateStep(latest.current!, step.id, { status: "submitted", txHash: result.txHash }));
            const status = await waitForConfirmation(result.txHash);
            if (status === "confirmed") commit(updateStep(latest.current!, step.id, { status: "confirmed" }));
            else if (status === "failed") commit(updateStep(latest.current!, step.id, { status: "failed", errorCode: "SIMULATION_FAILED", errorMessage: "Transaction reverted onchain." }));
            else commit(updateStep(latest.current!, step.id, { status: "submitted" }));
            // The leg's own trade record was written at submission; tell it how the leg ended.
            if (status === "confirmed" || status === "failed") void apiPatch(`/api/trades/${result.recordId}`, { status }).catch(() => undefined);
          } else {
            commit(updateStep(latest.current!, step.id, { status: "confirmed" }));
          }
        } catch (err) {
          const code = fail(step.id, err);
          if (code === "USER_REJECTED" || code === "WRONG_NETWORK" || code === "WALLET_NOT_CONNECTED") break;
        }
      }
    },
    [address, chainId, walletClient, publicClient, commit, fail],
  );

  /** Every pending buy leg quoted at once; the ones that cannot be quoted are failed here and now. */
  const quoteAll = useCallback(
    async (steps: PortfolioExecutionStep[]): Promise<QuotedStep[]> => {
      const results = await Promise.allSettled(
        steps.map((step) => apiPost<ExecutableQuoteDTO>("/api/trade/quote", { side: "buy", assetAddress: step.assetAddress, sellAmount: step.sellAmountUsdc, orders: false, taker: address, chainId: BASE_CHAIN_ID })),
      );
      const legs: QuotedStep[] = [];
      results.forEach((r, i) => {
        const step = steps[i]!;
        if (r.status === "rejected") {
          fail(step.id, r.reason);
          return;
        }
        const q = r.value;
        if (q.balanceInsufficient) {
          fail(step.id, new ApiError("INSUFFICIENT_BALANCE", TRADE_ERROR_COPY.INSUFFICIENT_BALANCE, 400));
          return;
        }
        if (!q.transaction) {
          fail(step.id, new ApiError("PROVIDER_UNAVAILABLE", "The provider returned no transaction for this leg.", 502));
          return;
        }
        commit(updateStep(latest.current!, step.id, { status: "quoted", provider: q.provider }), false);
        legs.push({ stepId: step.id, step, quote: q, sellToken: q.sellToken, sellAmount: BigInt(q.sellAmount), spender: q.allowanceSpender ?? null, call: { to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value) } });
      });
      return legs;
    },
    [address, commit, fail],
  );

  /** The activity record for one leg of a batch, written once its receipt is in — so it is born confirmed. */
  const recordTrade = useCallback(
    (leg: QuotedStep, txHash: Hash) =>
      apiPost("/api/trades", {
        id: newId("trade"),
        owner: address,
        side: "buy",
        assetAddress: leg.step.assetAddress,
        sellAmount: leg.quote.sellAmount,
        buyAmount: leg.quote.buyAmount,
        usdValue: leg.step.targetUsd,
        provider: leg.quote.provider,
        txHash,
        status: "confirmed",
      }).catch(() => undefined),
    [address],
  );

  /**
   * A basket of buys. Returns true when it settled every leg itself; false to hand the legs to the
   * leg-by-leg path (after the shared approvals, when those went through).
   */
  const runBasket = useCallback(
    async (steps: PortfolioExecutionStep[]): Promise<boolean> => {
      if (!address || !walletClient || !publicClient) return false;
      const legs = await quoteAll(steps);
      if (legs.length === 0) return true;

      const needs = allowanceNeeds(legs);
      const current = await Promise.all(needs.map((n) => publicClient.readContract({ address: n.token, abi: erc20Abi, functionName: "allowance", args: [address, n.spender] }).catch(() => 0n)));
      const approvals = approvalCalls(needs, (n) => current[needs.indexOf(n)] ?? 0n);
      const caps = await walletCapabilities(walletClient, address);

      // One confirmation for everything, on a wallet that takes a batch.
      if (caps.supported && (legs.length > 1 || approvals.length > 0)) {
        const calls: Call[] = [...approvals, ...legs.map((l) => l.call)];
        let simulated = true;
        try {
          await simulateBundle(publicClient, address, calls);
        } catch {
          // A revert somewhere in the bundle: leg by leg names the leg, a batch would only say "failed".
          simulated = false;
        }
        if (simulated) {
          let sent = false;
          try {
            for (const l of legs) setCurrentStepId(l.stepId);
            const { id } = await walletClient.sendCalls({
              account: address,
              chain: base,
              ...(caps.atomic ? { forceAtomic: true } : {}),
              calls: calls.map((c) => ({ to: c.to, data: withAttribution(c.data), value: c.value })),
              capabilities: { ...attributionCapabilities(), ...(caps.paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
            });
            sent = true;
            for (const l of legs) commit(updateStep(latest.current!, l.stepId, { status: "submitted" }));
            const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
            const receipts = result.receipts ?? [];
            legs.forEach((l, i) => {
              const receipt = receiptForLeg(receipts, approvals.length, i, legs.length);
              const ok = result.status === "success" && receipt?.status === "success";
              if (ok && receipt) {
                commit(updateStep(latest.current!, l.stepId, { status: "confirmed", txHash: receipt.transactionHash }));
                void recordTrade(l, receipt.transactionHash);
              } else {
                commit(updateStep(latest.current!, l.stepId, { status: "failed", errorCode: "SIMULATION_FAILED", errorMessage: result.status === "failure" ? "The batched transaction reverted; nothing in it was bought." : "This purchase reverted onchain.", txHash: receipt?.transactionHash }));
              }
            });
            return true;
          } catch (err) {
            const h = humanizeError(err);
            if (sent) {
              // Submitted but never confirmed to us: the wallet has it; say so rather than resend anything.
              for (const l of legs) commit(updateStep(latest.current!, l.stepId, { status: "submitted" }));
              return true;
            }
            if (h.code === "USER_REJECTED") {
              for (const l of legs) commit(updateStep(latest.current!, l.stepId, { status: "failed", errorCode: h.code, errorMessage: h.message }));
              return true;
            }
            // The wallet advertised batching and then refused the batch: leg by leg, with the approvals shared.
          }
        }
      }

      // The approvals once, for the whole basket; then each purchase on its own.
      let approved = false;
      for (const a of approvals) {
        try {
          const hash = await walletClient.sendTransaction({ account: address, chain: base, to: a.to, data: withAttribution(a.data) });
          await publicClient.waitForTransactionReceipt({ hash });
          approved = true;
        } catch (err) {
          const h = humanizeError(err);
          if (h.code === "USER_REJECTED") {
            for (const l of legs) commit(updateStep(latest.current!, l.stepId, { status: "failed", errorCode: h.code, errorMessage: h.message }));
            return true;
          }
          // A shared approval that did not go through is not fatal: the leg approves for itself below.
        }
      }
      // A quote fetched before the approval still says "allowance required"; after one, every leg re-quotes.
      const prefetched = approved ? undefined : new Map(legs.map((l) => [l.stepId, l.quote] as const));
      await runLegByLeg(
        legs.map((l) => l.step),
        prefetched,
      );
      return true;
    },
    [address, walletClient, publicClient, quoteAll, recordTrade, runLegByLeg, commit],
  );

  const runPending = useCallback(async (): Promise<PortfolioExecution | null> => {
    const exec = latest.current;
    if (!exec || !address || !walletClient || !publicClient) return exec;
    setRunning(true);
    try {
      const pending = exec.steps.filter((s) => s.status === "pending");
      const buysOnly = pending.length > 0 && pending.every((s) => (s.side ?? "buy") === "buy");
      if (buysOnly && chainId === BASE_CHAIN_ID) {
        const handled = await runBasket(pending);
        if (handled) return latest.current;
      }
      await runLegByLeg(pending);
    } finally {
      setCurrentStepId(null);
      setRunning(false);
    }
    return latest.current;
  }, [address, chainId, walletClient, publicClient, runBasket, runLegByLeg]);

  /**
   * The record is the wallet's own, so it is written under its session: one sign-in per session
   * keeps partial fills on file. Declining the sign-in still runs the trades, just without a record.
   */
  const persistNew = useCallback(
    async (exec: PortfolioExecution) => {
      latest.current = exec;
      setExecution(exec);
      persisted.current = false;
      const signedIn = await auth.ensureSignedIn().catch(() => false);
      if (!signedIn) return;
      await apiPost("/api/portfolio/executions", { id: exec.id, owner: exec.owner, totalUsd: exec.totalUsd, steps: exec.steps })
        .then(() => {
          persisted.current = true;
        })
        .catch(() => undefined);
    },
    [auth],
  );

  const start = useCallback(
    async (plan: PortfolioPlan) => {
      if (!address) throw new Error(TRADE_ERROR_COPY.WALLET_NOT_CONNECTED);
      await persistNew(createExecution(address as Address, plan));
      return runPending();
    },
    [address, persistNew, runPending],
  );

  const startLegs = useCallback(
    async (legs: CustomLeg[]) => {
      if (!address) throw new Error(TRADE_ERROR_COPY.WALLET_NOT_CONNECTED);
      await persistNew(createCustomExecution(address as Address, legs));
      return runPending();
    },
    [address, persistNew, runPending],
  );

  const retry = useCallback(
    async (stepIds?: string[]) => {
      if (!latest.current) return null;
      commit(resetFailedSteps(latest.current, stepIds));
      return runPending();
    },
    [commit, runPending],
  );

  const reset = useCallback(() => {
    latest.current = null;
    persisted.current = false;
    setExecution(null);
    setCurrentStepId(null);
  }, []);

  return { execution, currentStepId, running, start, startLegs, retry, reset, summary: execution ? summarize(execution) : null };
}

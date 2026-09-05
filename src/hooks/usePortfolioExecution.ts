"use client";

import { useCallback, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address } from "viem";
import type { PortfolioExecution, PortfolioPlan } from "@/domain/portfolio";
import { apiPatch, apiPost, ApiError } from "@/lib/client-api";
import { createCustomExecution, createExecution, resetFailedSteps, summarize, updateStep, type CustomLeg } from "@/lib/execution/portfolio-execution";
import { executeTrade, waitForConfirmation } from "@/lib/trade/execute";
import { humanizeError, TRADE_ERROR_COPY } from "@/lib/errors";
import { BASE_CHAIN_ID } from "@/config/chain";
import { useAuth } from "./useAuth";

/**
 * Multi-leg execution (spec §25, §26). Legs run sequentially through the same executor and
 * B20Guard as single trades; sell legs are supported for manual rebalancing. A failed leg never
 * rolls back completed legs; the UI shows "3 of 4 completed" with a retry.
 *
 * `start` and `startLegs` resolve with the execution as it stands when the last leg has settled,
 * so a caller can tell what was actually bought (a rejected wallet prompt is not a run).
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

  const runPending = useCallback(async (): Promise<PortfolioExecution | null> => {
    const exec = latest.current;
    if (!exec || !address || !walletClient || !publicClient) return exec;
    setRunning(true);
    try {
      for (const step of exec.steps) {
        const cur = latest.current!;
        const live = cur.steps.find((s) => s.id === step.id)!;
        if (live.status !== "pending") continue;
        setCurrentStepId(step.id);
        const side = live.side ?? "buy";
        const amount = side === "sell" ? BigInt(live.sellAmount ?? "0") : BigInt(live.sellAmountUsdc);
        try {
          const result = await executeTrade(
            { address, chainId, walletClient, publicClient },
            { side, assetAddress: step.assetAddress, sellAmount: amount, usdValue: step.targetUsd, orders: false },
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
          } else {
            commit(updateStep(latest.current!, step.id, { status: "confirmed" }));
          }
        } catch (err) {
          const h = err instanceof ApiError ? { code: err.code, message: err.message } : humanizeError(err);
          commit(updateStep(latest.current!, step.id, { status: "failed", errorCode: h.code, errorMessage: h.message }));
          if (h.code === "USER_REJECTED" || h.code === "WRONG_NETWORK" || h.code === "WALLET_NOT_CONNECTED") break;
        }
      }
    } finally {
      setCurrentStepId(null);
      setRunning(false);
    }
    return latest.current;
  }, [address, chainId, walletClient, publicClient, commit]);

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

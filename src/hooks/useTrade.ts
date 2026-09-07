"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { Address, Hash } from "viem";
import { apiPatch, apiPost, ApiError, type ExecutableQuoteDTO, type OrderView } from "@/lib/client-api";
import type { TradeSide, TradeState } from "@/domain/trade";
import { humanizeError, TRADE_ERROR_COPY, type HumanError } from "@/lib/errors";
import { BASE_CHAIN_ID } from "@/config/chain";
import { executeTrade, type ExecutionMode } from "@/lib/trade/execute";
import { useOrderStatus, useTxStatus } from "./queries";

export interface TradeExecParams {
  side: TradeSide;
  assetAddress: Address;
  sellAmount: bigint;
  /** Buys: pay with USDC (default) or native ETH. */
  payWith?: "USDC" | "ETH";
  provider?: import("@/domain/trade").TradeProviderId;
  strictProvider?: boolean;
  recipient?: Address;
  slippageBps?: number;
  /** For the activity record only. */
  usdValue?: number | null;
  /** false = transactions only (no signed orders). */
  orders?: boolean;
}

export interface TradeRun {
  state: TradeState;
  /** Fetches the firm quote for the review screen; execute() reuses it while fresh. */
  prepare: (params: TradeExecParams) => Promise<void>;
  error: HumanError | null;
  quote: ExecutableQuoteDTO | null;
  txHash?: Hash;
  approvalHash?: Hash;
  mode: ExecutionMode | null;
  sponsored: boolean;
  /** Signed order (CoW) being filled; `order` is its polled state. */
  orderUid?: string;
  order: OrderView | null;
  execute: (params: TradeExecParams) => Promise<void>;
  reset: () => void;
  isBusy: boolean;
}

const BUSY: TradeState[] = ["GETTING_FIRM_QUOTE", "APPROVAL_REQUIRED", "AWAITING_WALLET", "SUBMITTED", "PRECONFIRMED"];

/**
 * Trade sheet state machine (spec §47) on top of the shared executor.
 * Chain confirmation state is derived from the polled status, never set from an effect.
 * Signed orders derive it from the order book instead: open → filled (with the settlement hash).
 */
export function useTrade(): TradeRun {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: BASE_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });

  const [machine, setMachine] = useState<TradeState>("IDLE");
  const [localError, setLocalError] = useState<HumanError | null>(null);
  const [quote, setQuote] = useState<ExecutableQuoteDTO | null>(null);
  const [txHash, setTxHash] = useState<Hash | undefined>();
  const [approvalHash, setApprovalHash] = useState<Hash | undefined>();
  const [mode, setMode] = useState<TradeRun["mode"]>(null);
  const [sponsored, setSponsored] = useState(false);
  const [orderUid, setOrderUid] = useState<string | undefined>();
  const recordId = useRef<string | null>(null);
  const reported = useRef<string | null>(null);
  const status = useTxStatus(txHash);
  const orderStatus = useOrderStatus(orderUid);
  const order = orderUid ? (orderStatus.data ?? null) : null;
  const chain = txHash ? status.data?.status : undefined;

  // Derived state: Submitted → Preconfirmed → Confirmed / Failed.
  let state: TradeState = machine;
  let error: HumanError | null = localError;
  if (machine === "SUBMITTED" || machine === "PRECONFIRMED") {
    if (order) {
      if (order.status === "fulfilled") state = "CONFIRMED";
      else if (order.status === "expired") {
        state = "FAILED";
        error = { code: "QUOTE_EXPIRED", message: "No solver filled the order before it expired. Your funds were not moved; try again or use a swap route." };
      } else if (order.status === "cancelled") {
        state = "FAILED";
        error = { code: "USER_REJECTED", message: "The order was cancelled. Your funds were not moved." };
      } else if (BigInt(order.executedBuyAmount) > 0n) state = "PRECONFIRMED";
    } else if (chain === "preconfirmed") state = "PRECONFIRMED";
    else if (chain === "confirmed") state = "CONFIRMED";
    else if (chain === "failed") {
      state = "FAILED";
      // The route is simulated before the wallet opens, so a revert here means the state changed
      // between that simulation and inclusion — on a swap with a minimum-output check, that is the
      // pool price moving past the slippage limit. Saying so beats "reverted onchain", which tells
      // a reader neither what happened nor what to do about it.
      error = {
        code: "SIMULATION_FAILED",
        message: "This reverted after it was sent. It simulated cleanly first, so the pool price moved past your slippage limit in between — no tokens changed hands, only the network fee was spent. Try again for a fresh quote, or raise slippage before retrying.",
        detail: txHash,
      };
    }
  }
  const settledHash = txHash ?? order?.txHash ?? undefined;

  // Side effects only (record status); no state updates inside effects.
  useEffect(() => {
    if (!recordId.current) return;
    if (txHash && (chain === "confirmed" || chain === "failed") && reported.current !== `${txHash}:${chain}`) {
      reported.current = `${txHash}:${chain}`;
      void apiPatch(`/api/trades/${recordId.current}`, { status: chain }).catch(() => undefined);
    }
    if (order && (order.status === "fulfilled" || order.status === "expired" || order.status === "cancelled") && reported.current !== `${order.uid}:${order.status}`) {
      reported.current = `${order.uid}:${order.status}`;
      void apiPatch(`/api/trades/${recordId.current}`, order.status === "fulfilled" ? { status: "confirmed", txHash: order.txHash ?? undefined } : { status: "failed" }).catch(() => undefined);
    }
  }, [chain, txHash, order]);

  const reset = useCallback(() => {
    setMachine("IDLE");
    setLocalError(null);
    setQuote(null);
    setTxHash(undefined);
    setApprovalHash(undefined);
    setMode(null);
    setSponsored(false);
    setOrderUid(undefined);
    recordId.current = null;
    reported.current = null;
  }, []);

  const prepare = useCallback(
    async (params: TradeExecParams) => {
      if (!address) return;
      setMachine("GETTING_FIRM_QUOTE");
      setLocalError(null);
      try {
        const q = await apiPost<ExecutableQuoteDTO>("/api/trade/quote", {
          side: params.side,
          assetAddress: params.assetAddress,
          sellAmount: params.sellAmount.toString(),
          payWith: params.payWith,
          provider: params.provider,
          strictProvider: params.strictProvider,
          orders: params.orders,
          taker: address,
          recipient: params.recipient,
          slippageBps: params.slippageBps,
          chainId: BASE_CHAIN_ID,
        });
        setQuote(q);
        setMachine("READY");
      } catch (err) {
        setLocalError(err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message, detail: err.code } : humanizeError(err));
        setMachine("IDLE");
      }
    },
    [address],
  );

  const execute = useCallback(
    async (params: TradeExecParams) => {
      setLocalError(null);
      setTxHash(undefined);
      setApprovalHash(undefined);
      setOrderUid(undefined);
      if (!address || !walletClient || !publicClient) {
        setLocalError({ code: "WALLET_NOT_CONNECTED", message: TRADE_ERROR_COPY.WALLET_NOT_CONNECTED });
        setMachine("FAILED");
        return;
      }
      try {
        const result = await executeTrade(
          { address, chainId, walletClient, publicClient },
          { ...params, prefetchedQuote: quote && Date.now() < quote.expiresAt ? quote : undefined },
          {
            onState: setMachine,
            onQuote: setQuote,
            onApproval: setApprovalHash,
            onMode: (m, s) => {
              setMode(m);
              setSponsored(s);
            },
            onSubmitted: (_hash, id, uid) => {
              recordId.current = id;
              if (uid) setOrderUid(uid);
            },
          },
        );
        if (result.txHash) setTxHash(result.txHash);
        setMachine("SUBMITTED");
      } catch (err) {
        const h = err instanceof ApiError ? { code: (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as HumanError["code"], message: err.message, detail: err.code } : humanizeError(err);
        setLocalError(h);
        setMachine("FAILED");
      }
    },
    [address, chainId, walletClient, publicClient, quote],
  );

  return { state, error, quote, txHash: settledHash, approvalHash, mode, sponsored, orderUid, order, prepare, execute, reset, isBusy: BUSY.includes(state) };
}

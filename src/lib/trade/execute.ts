import { isNativeEth } from "@/config/chain";
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { apiGet, apiPost, ApiError, type ExecutableQuoteDTO, type TxStatusResponse } from "@/lib/client-api";
import type { TradeSide, TradeState } from "@/domain/trade";
import { humanizeError, TRADE_ERROR_COPY } from "@/lib/errors";
import { withAttribution } from "@/lib/attribution";
import { BASE_CHAIN_ID } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { newId } from "@/lib/execution/portfolio-execution";

export interface ExecuteTradeParams {
  side: TradeSide;
  assetAddress: Address;
  sellAmount: bigint;
  /** Buys: pay with USDC (default) or native ETH. */
  payWith?: "USDC" | "ETH";
  /** Provider that won the indicative comparison. */
  provider?: import("@/domain/trade").TradeProviderId;
  /** True when the user picked the provider manually (no fallback to others). */
  strictProvider?: boolean;
  recipient?: Address;
  slippageBps?: number;
  usdValue?: number | null;
}

export interface ExecuteTradeContext {
  address: Address;
  chainId: number | undefined;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

export interface ExecuteTradeHooks {
  onState?: (state: TradeState) => void;
  onQuote?: (quote: ExecutableQuoteDTO) => void;
  onApproval?: (hash: Hash) => void;
  onMode?: (mode: "sequential" | "batched", sponsored: boolean) => void;
  onSubmitted?: (hash: Hash | undefined, recordId: string) => void;
}

export interface ExecuteTradeResult {
  txHash: Hash | undefined;
  recordId: string;
  quote: ExecutableQuoteDTO;
  mode: "sequential" | "batched";
}

/**
 * Shared trade executor used by the trade sheet and by multi-leg portfolio execution.
 * Fresh executable quote → allowance (scoped approval of the provider's spender only) →
 * simulation → submit with Builder Code suffix. Base Account batches approve + swap atomically.
 */
export async function executeTrade(ctx: ExecuteTradeContext, params: ExecuteTradeParams, hooks: ExecuteTradeHooks = {}): Promise<ExecuteTradeResult> {
  const { address, walletClient, publicClient } = ctx;
  if (ctx.chainId !== BASE_CHAIN_ID) throw new ApiError("WRONG_NETWORK", TRADE_ERROR_COPY.WRONG_NETWORK, 400);

  const fetchQuote = async (): Promise<ExecutableQuoteDTO> => {
    hooks.onState?.("GETTING_FIRM_QUOTE");
    const q = await apiPost<ExecutableQuoteDTO>("/api/trade/quote", {
      side: params.side,
      assetAddress: params.assetAddress,
      sellAmount: params.sellAmount.toString(),
      payWith: params.payWith,
      provider: params.provider,
      strictProvider: params.strictProvider,
      taker: address,
      recipient: params.recipient,
      slippageBps: params.slippageBps,
      chainId: BASE_CHAIN_ID,
    });
    hooks.onQuote?.(q);
    return q;
  };

  let q = await fetchQuote();
  if (q.balanceInsufficient) throw new ApiError("INSUFFICIENT_BALANCE", TRADE_ERROR_COPY.INSUFFICIENT_BALANCE, 400);

  // Native ETH is sent as tx value: no ERC-20 allowance step.
  const nativeSell = isNativeEth(q.sellToken);
  const spender = nativeSell ? null : q.allowanceSpender;
  let needsApproval = !nativeSell && q.allowanceRequired;
  if (spender && !needsApproval) {
    const current = await publicClient.readContract({ address: q.sellToken, abi: erc20Abi, functionName: "allowance", args: [address, spender] });
    needsApproval = current < BigInt(q.sellAmount);
  }
  if (needsApproval && !spender) throw new ApiError("ROUTE_UNAVAILABLE", "The provider did not return an approval target.", 502);
  const approveData = spender ? encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(q.sellAmount)] }) : null;

  let atomic = false;
  let paymaster = false;
  try {
    const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
    atomic = caps.atomic?.status === "supported" || caps.atomic?.status === "ready";
    paymaster = !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported;
  } catch {
    atomic = false;
  }

  // The activity record is created only once something was actually submitted to the wallet,
  // so a cancelled review never shows up in Activity.
  const recordId = newId("trade");
  const record = (quote: ExecutableQuoteDTO, txHash?: Hash) =>
    apiPost("/api/trades", {
      id: recordId,
      owner: address,
      side: params.side,
      assetAddress: params.assetAddress,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
      usdValue: params.usdValue ?? null,
      provider: quote.provider,
      recipient: params.recipient,
      txHash,
    }).catch(() => undefined);

  try {
    if (needsApproval && atomic && approveData) {
      hooks.onMode?.("batched", paymaster);
      hooks.onState?.("AWAITING_WALLET");
      const { id } = await walletClient.sendCalls({
        account: address,
        chain: base,
        forceAtomic: true,
        calls: [
          { to: q.sellToken, data: withAttribution(approveData) },
          { to: q.transaction.to, data: withAttribution(q.transaction.data), value: BigInt(q.transaction.value) },
        ],
        ...(paymaster ? { capabilities: { paymasterService: { url: publicEnv.paymasterUrl } } } : {}),
      });
      hooks.onState?.("SUBMITTED");
      hooks.onSubmitted?.(undefined, recordId);
      const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
      const hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
      if (result.status === "failure") throw new Error("Batched transaction failed");
      if (hash) void record(q, hash);
      return { txHash: hash, recordId, quote: q, mode: "batched" };
    }

    hooks.onMode?.("sequential", false);
    if (needsApproval && approveData) {
      hooks.onState?.("APPROVAL_REQUIRED");
      hooks.onState?.("AWAITING_WALLET");
      const ah = await walletClient.sendTransaction({ account: address, chain: base, to: q.sellToken, data: withAttribution(approveData) });
      hooks.onApproval?.(ah);
      await publicClient.waitForTransactionReceipt({ hash: ah });
      q = await fetchQuote(); // spec §19.4: refresh after approval
    }
    if (Date.now() > q.expiresAt) q = await fetchQuote();

    try {
      await publicClient.call({ account: address, to: q.transaction.to, data: q.transaction.data as Hex, value: BigInt(q.transaction.value) });
    } catch (simErr) {
      const h = humanizeError(simErr);
      if (h.code === "QUOTE_EXPIRED" || h.code === "SLIPPAGE") q = await fetchQuote();
      else throw simErr;
    }

    hooks.onState?.("AWAITING_WALLET");
    const hash = await walletClient.sendTransaction({
      account: address,
      chain: base,
      to: q.transaction.to,
      data: withAttribution(q.transaction.data),
      value: BigInt(q.transaction.value),
    });
    hooks.onState?.("SUBMITTED");
    hooks.onSubmitted?.(hash, recordId);
    void record(q, hash);
    return { txHash: hash, recordId, quote: q, mode: "sequential" };
  } catch (err) {
    // Nothing was submitted (or the wallet rejected): no record exists, nothing to mark.
    throw err;
  }
}

/** Poll our status route until confirmed/failed (Flashblocks-aware with receipt fallback). */
export async function waitForConfirmation(hash: Hash, opts?: { timeoutMs?: number; intervalMs?: number; onStatus?: (s: TxStatusResponse["status"]) => void }): Promise<TxStatusResponse["status"]> {
  const started = Date.now();
  const timeout = opts?.timeoutMs ?? 180_000;
  const interval = opts?.intervalMs ?? 1_200;
  while (Date.now() - started < timeout) {
    try {
      const s = await apiGet<TxStatusResponse>(`/api/tx/${hash}`);
      opts?.onStatus?.(s.status);
      if (s.status === "confirmed" || s.status === "failed") return s.status;
    } catch {
      /* transient */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return "unknown";
}

import { isNativeEth } from "@/config/chain";
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { apiDelete, apiGet, apiPost, ApiError, type ExecutableQuoteDTO, type SignedOrderRequest, type TxStatusResponse } from "@/lib/client-api";
import type { TradeSide, TradeState } from "@/domain/trade";
import { humanizeError, TRADE_ERROR_COPY } from "@/lib/errors";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
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
  /** false = transactions only; signed-order providers (CoW) are left out. Basket legs need a hash per leg. */
  orders?: boolean;
  /** Firm quote already fetched for the review screen; reused while fresh instead of fetching again. */
  prefetchedQuote?: ExecutableQuoteDTO;
}

export interface ExecuteTradeContext {
  address: Address;
  chainId: number | undefined;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

export type ExecutionMode = "sequential" | "batched" | "order";

export interface ExecuteTradeHooks {
  onState?: (state: TradeState) => void;
  onQuote?: (quote: ExecutableQuoteDTO) => void;
  onApproval?: (hash: Hash) => void;
  onMode?: (mode: ExecutionMode, sponsored: boolean) => void;
  /** `orderUid` is set for signed orders, which have no transaction hash until a solver fills them. */
  onSubmitted?: (hash: Hash | undefined, recordId: string, orderUid?: string) => void;
}

export interface ExecuteTradeResult {
  txHash: Hash | undefined;
  recordId: string;
  quote: ExecutableQuoteDTO;
  mode: ExecutionMode;
  /** CoW order uid; poll /api/trade/orders/[uid] for the fill. */
  orderUid?: string;
}

/** Wallet capabilities that change how we submit: atomic batches and sponsored gas (Base Account). */
async function walletCapabilities(walletClient: WalletClient, address: Address): Promise<{ atomic: boolean; paymaster: boolean }> {
  try {
    const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
    return { atomic: caps.atomic?.status === "supported" || caps.atomic?.status === "ready", paymaster: !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported };
  } catch {
    return { atomic: false, paymaster: false };
  }
}

/**
 * Shared trade executor used by the trade sheet and by multi-leg portfolio execution.
 * Fresh executable quote → allowance (scoped approval of the provider's spender only) →
 * simulation → submit with Builder Code suffix. Base Account batches approve + swap atomically.
 * A CoW quote has no transaction: the wallet signs the order instead (see executeSignedOrder).
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
      orders: params.orders,
      taker: address,
      recipient: params.recipient,
      slippageBps: params.slippageBps,
      chainId: BASE_CHAIN_ID,
    });
    hooks.onQuote?.(q);
    return q;
  };

  let q = params.prefetchedQuote && Date.now() < params.prefetchedQuote.expiresAt ? params.prefetchedQuote : await fetchQuote();
  if (q.balanceInsufficient) throw new ApiError("INSUFFICIENT_BALANCE", TRADE_ERROR_COPY.INSUFFICIENT_BALANCE, 400);

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

  if (q.order) {
    const { orderUid } = await executeSignedOrder(ctx, q.order, {
      onState: hooks.onState,
      onApproval: hooks.onApproval,
      onMode: hooks.onMode,
    });
    hooks.onSubmitted?.(undefined, recordId, orderUid);
    void record(q);
    return { txHash: undefined, recordId, quote: q, mode: "order", orderUid };
  }
  if (!q.transaction) throw new ApiError("PROVIDER_UNAVAILABLE", "The provider returned neither a transaction nor an order.", 502);

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

  const { atomic, paymaster } = await walletCapabilities(walletClient, address);

  if (needsApproval && atomic && approveData) {
    hooks.onMode?.("batched", paymaster);
    // Simulate approve + swap as one bundle (eth_simulateV1) so a revert surfaces before the wallet
    // opens; RPCs without the method skip silently — the wallet itself still simulates.
    await simulateBundle(publicClient, address, [
      { to: q.sellToken, data: approveData },
      { to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value) },
    ]);
    hooks.onState?.("AWAITING_WALLET");
    const { id } = await walletClient.sendCalls({
      account: address,
      chain: base,
      forceAtomic: true,
      calls: [
        { to: q.sellToken, data: withAttribution(approveData) },
        { to: q.transaction.to, data: withAttribution(q.transaction.data), value: BigInt(q.transaction.value) },
      ],
      capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
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
    if (!q.transaction) throw new ApiError("PROVIDER_UNAVAILABLE", "The refreshed quote is not a transaction.", 502);
  }
  if (Date.now() > q.expiresAt) {
    q = await fetchQuote();
    if (!q.transaction) throw new ApiError("PROVIDER_UNAVAILABLE", "The refreshed quote is not a transaction.", 502);
  }

  try {
    await callAfterApproval(publicClient, address, { to: q.transaction.to, data: q.transaction.data as Hex, value: BigInt(q.transaction.value) });
  } catch (simErr) {
    const h = humanizeError(simErr);
    if (h.code === "QUOTE_EXPIRED" || h.code === "SLIPPAGE") {
      q = await fetchQuote();
      if (!q.transaction) throw new ApiError("PROVIDER_UNAVAILABLE", "The refreshed quote is not a transaction.", 502);
    } else throw simErr;
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
}

/**
 * Simulate a call that depends on an approval we just mined. The fallback transport spreads
 * requests across RPCs, and a public node can lag the approve receipt by a block or two - an
 * "insufficient allowance" revert right after our own approval is stale state, not a real
 * failure, so it retries briefly before surfacing.
 */
export async function callAfterApproval(publicClient: PublicClient, account: Address, call: { to: Address; data: Hex; value?: bigint }, attempts = 4): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await publicClient.call({ account, to: call.to, data: call.data, value: call.value });
      return;
    } catch (err) {
      if (humanizeError(err).code === "ALLOWANCE_REQUIRED" && i < attempts) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
}

/** eth_simulateV1 bundle check; unsupported RPCs and transport hiccups skip rather than block. */
export async function simulateBundle(publicClient: PublicClient, account: Address, calls: Array<{ to: Address; data: Hex; value?: bigint }>): Promise<void> {
  try {
    const { results } = await publicClient.simulateCalls({ account, calls });
    const failed = results.find((r) => r.status === "failure");
    if (failed) {
      const err = failed.error;
      throw err instanceof Error ? err : new Error(typeof err === "string" ? err : "Simulation reported a revert");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/eth_simulateV1|method not (found|supported)|not implemented|-32601|does not exist/i.test(msg)) return;
    const h = humanizeError(err);
    if (h.code === "UNKNOWN" || h.code === "PROVIDER_UNAVAILABLE") return; // never block on infra noise
    throw new ApiError(h.code, h.message, 400, undefined, undefined);
  }
}

/* ---------- signed orders (CoW Protocol) ---------- */

const ERC6492_SUFFIX = "6492649264926492649264926492649264926492649264926492649264926492";

/** Smart accounts sign with ERC-1271; CoW verifies onchain. EOAs sign plain EIP-712. */
export async function signingSchemeFor(publicClient: PublicClient, address: Address): Promise<"eip712" | "eip1271"> {
  const code = await publicClient.getCode({ address }).catch(() => undefined);
  return code && code !== "0x" ? "eip1271" : "eip712";
}

export interface SignedOrderHooks {
  onState?: (state: TradeState) => void;
  onApproval?: (hash: Hash) => void;
  onMode?: (mode: ExecutionMode, sponsored: boolean) => void;
}

/**
 * Approve the vault relayer for exactly the sell amount (a transaction, sponsored on Base Account
 * when a paymaster is configured), sign the order, hand it to the order book. Gas for the swap
 * itself is paid by the solver. Returns the order uid to poll.
 */
export async function executeSignedOrder(ctx: ExecuteTradeContext, order: SignedOrderRequest, hooks: SignedOrderHooks = {}): Promise<{ orderUid: string; approvalHash?: Hash }> {
  const { address, walletClient, publicClient } = ctx;
  if (ctx.chainId !== BASE_CHAIN_ID) throw new ApiError("WRONG_NETWORK", TRADE_ERROR_COPY.WRONG_NETWORK, 400);
  const m = order.typedData.message;
  const sellAmount = BigInt(m.sellAmount);

  const { paymaster, atomic } = await walletCapabilities(walletClient, address);
  hooks.onMode?.("order", paymaster);

  const balance = await publicClient.readContract({ address: m.sellToken, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  if (balance < sellAmount) throw new ApiError("INSUFFICIENT_BALANCE", TRADE_ERROR_COPY.INSUFFICIENT_BALANCE, 400);

  let approvalHash: Hash | undefined;
  const allowance = await publicClient.readContract({ address: m.sellToken, abi: erc20Abi, functionName: "allowance", args: [address, order.allowanceTarget] });
  if (allowance < sellAmount) {
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [order.allowanceTarget, sellAmount] });
    hooks.onState?.("APPROVAL_REQUIRED");
    hooks.onState?.("AWAITING_WALLET");
    if (atomic) {
      const { id } = await walletClient.sendCalls({
        account: address,
        chain: base,
        calls: [{ to: m.sellToken, data: withAttribution(approveData) }],
        capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
      });
      const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
      if (result.status === "failure") throw new Error("Approval failed");
      approvalHash = result.receipts?.[0]?.transactionHash;
    } else {
      approvalHash = await walletClient.sendTransaction({ account: address, chain: base, to: m.sellToken, data: withAttribution(approveData) });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    }
    if (approvalHash) hooks.onApproval?.(approvalHash);
  }

  // Decided after the approval: a fresh Base Account is deployed by its first transaction.
  const signingScheme = await signingSchemeFor(publicClient, address);
  hooks.onState?.("AWAITING_WALLET");
  const signature = await walletClient.signTypedData({
    account: address,
    domain: order.typedData.domain,
    types: order.typedData.types,
    primaryType: "Order",
    message: {
      sellToken: m.sellToken,
      buyToken: m.buyToken,
      receiver: m.receiver,
      sellAmount,
      buyAmount: BigInt(m.buyAmount),
      validTo: m.validTo,
      appData: m.appData,
      feeAmount: 0n,
      kind: m.kind,
      partiallyFillable: m.partiallyFillable,
      sellTokenBalance: m.sellTokenBalance,
      buyTokenBalance: m.buyTokenBalance,
    },
  });
  if (signature.toLowerCase().endsWith(ERC6492_SUFFIX)) {
    throw new ApiError("SIMULATION_FAILED", "This smart wallet is not deployed yet, so CoW Protocol cannot verify its signature. Make any one transaction with it first (an approval or a swap), then place the order.", 400);
  }

  const { uid } = await apiPost<{ uid: string }>("/api/trade/orders", { from: address, signature, signingScheme, order });
  hooks.onState?.("SUBMITTED");
  return { orderUid: uid, approvalHash };
}

const SETTLEMENT_ABI = [{ type: "function", name: "invalidateOrder", stateMutability: "nonpayable", inputs: [{ name: "orderUid", type: "bytes" }], outputs: [] }] as const;

/**
 * Cancel an open order. EOAs sign an offchain cancellation (free, instant); smart accounts
 * invalidate onchain, which is a small transaction on the settlement contract.
 */
export async function cancelSignedOrder(ctx: ExecuteTradeContext, order: { uid: string; domain: SignedOrderRequest["typedData"]["domain"] }): Promise<{ txHash?: Hash }> {
  const { address, walletClient, publicClient } = ctx;
  const scheme = await signingSchemeFor(publicClient, address);
  if (scheme === "eip712") {
    const signature = await walletClient.signTypedData({
      account: address,
      domain: order.domain,
      types: { OrderCancellations: [{ name: "orderUids", type: "bytes[]" }] },
      primaryType: "OrderCancellations",
      message: { orderUids: [order.uid as Hex] },
    });
    await apiDelete(`/api/trade/orders/${order.uid}`, { signature, signingScheme: "eip712" });
    return {};
  }
  const data = encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: "invalidateOrder", args: [order.uid as Hex] });
  const txHash = await walletClient.sendTransaction({ account: address, chain: base, to: order.domain.verifyingContract, data: withAttribution(data) });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash };
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

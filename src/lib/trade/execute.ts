import { isNativeEth } from "@/config/chain";
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { base } from "viem/chains";
import { apiDelete, apiGet, apiPost, ApiError, type ExecutableQuoteDTO, type SignedOrderRequest, type TxStatusResponse } from "@/lib/client-api";
import type { TradeProviderId, TradeSide, TradeState } from "@/domain/trade";
import { humanizeError, TRADE_ERROR_COPY } from "@/lib/errors";
import { attributionCapabilities, withAttribution } from "@/lib/attribution";
import { BASE_CHAIN_ID, DEFAULT_SLIPPAGE_BPS } from "@/config/chain";
import { publicEnv } from "@/config/env";
import { newId } from "@/lib/execution/portfolio-execution";

export interface ExecuteTradeParams {
  side: TradeSide;
  assetAddress: Address;
  sellAmount: bigint;
  /** Buys: pay with USDC (default) or native ETH. */
  payWith?: "USDC" | "ETH";
  /** Provider that won the indicative comparison. */
  provider?: TradeProviderId;
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

/** A quote that carries calldata; the sequential and batched paths only work with these. */
type TxQuote = ExecutableQuoteDTO & { transaction: NonNullable<ExecutableQuoteDTO["transaction"]> };

function asTxQuote(q: ExecutableQuoteDTO): TxQuote {
  if (!q.transaction) throw new ApiError("PROVIDER_UNAVAILABLE", "The refreshed quote is not a transaction.", 502);
  return q as TxQuote;
}

/* ---------- re-quotes ---------- */

/** Marker in `ApiError.details`: the sheet should go back to READY with the refreshed quote, not to FAILED. */
export const REVIEW_AGAIN = "reviewAgain";

/**
 * The refreshed quote is not what the user reviewed. Nothing was sent; the sheet shows the new
 * numbers and asks for another look instead of opening the wallet on a trade nobody approved.
 */
export function reviewAgainError(message: string, fresh: ExecutableQuoteDTO): ApiError {
  return new ApiError("QUOTE_EXPIRED", `${message} Review the refreshed quote before confirming.`, 409, { [REVIEW_AGAIN]: true, provider: fresh.provider });
}

export function isReviewAgain(err: unknown): boolean {
  return err instanceof ApiError && err.details?.[REVIEW_AGAIN] === true;
}

/**
 * Whether a quote fetched after the review still describes the trade the user approved.
 *
 * A re-quote used to be a fresh call to the router with the original parameters, so the route it
 * came back from could differ from the one on screen, and its output could be anything the new
 * route offered. The wallet then opened on a trade the user had never seen. A refetch now has to
 * come from the same provider and pay out at least what was reviewed less half the slippage
 * allowance; within that band it is the same trade a moment later, beyond it a different one.
 */
export function refetchedQuoteAcceptable(reviewed: ExecutableQuoteDTO, fresh: ExecutableQuoteDTO, slippageBps: number): { ok: true } | { ok: false; reason: string } {
  if (fresh.provider !== reviewed.provider) return { ok: false, reason: `The route changed from ${reviewed.provider} to ${fresh.provider}.` };
  // reviewed × (1 − slippage / 2), in basis points: (20 000 − bps) / 20 000.
  const floor = (BigInt(reviewed.buyAmount) * BigInt(20_000 - Math.max(0, Math.min(10_000, Math.round(slippageBps))))) / 20_000n;
  if (BigInt(fresh.buyAmount) < floor) return { ok: false, reason: "The price moved against you since you reviewed this quote." };
  return { ok: true };
}

/* ---------- trade record ---------- */

/** Waits between retries of a record the server could not yet match to a transaction; about ten seconds in all. */
const RECORD_RETRY_DELAYS_MS: readonly number[] = [2_500, 7_000];

/**
 * File the trade record, retrying while the server's RPC has not seen the hash yet.
 *
 * The record is posted the moment the wallet hands back a hash. The server matches it to a receipt
 * and, when its node is a block behind the wallet's, answers TX_PENDING; the post was fire-and-forget
 * and swallowed that, so a real trade left no record and the verification sweep had nothing to
 * finish. Anything other than "not seen yet" is final: the first answer stands.
 */
export async function postTradeRecord(body: unknown, delays: readonly number[] = RECORD_RETRY_DELAYS_MS): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await apiPost("/api/trades", body);
      return true;
    } catch (err) {
      const notSeenYet = err instanceof ApiError && err.code === "TX_PENDING";
      if (!notSeenYet || attempt >= delays.length) return false;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

/**
 * Wallet capabilities that change how we submit. `supported`: the wallet answers EIP-5792 at all,
 * so it can take a batch of calls in one confirmation; `atomic`: that batch is all-or-nothing
 * (Base Account, wallets upgraded under EIP-7702); `paymaster`: gas can be sponsored.
 */
export async function walletCapabilities(walletClient: WalletClient, address: Address): Promise<{ supported: boolean; atomic: boolean; paymaster: boolean }> {
  try {
    const caps = (await walletClient.getCapabilities({ account: address, chainId: BASE_CHAIN_ID })) as { atomic?: { status?: string }; paymasterService?: { supported?: boolean } };
    return { supported: true, atomic: caps.atomic?.status === "supported" || caps.atomic?.status === "ready", paymaster: !!publicEnv.paymasterUrl && !!caps.paymasterService?.supported };
  } catch {
    return { supported: false, atomic: false, paymaster: false };
  }
}

/**
 * Shared trade executor used by the trade sheet and by multi-leg portfolio execution.
 * Fresh executable quote → allowance (scoped approval of the provider's spender only) →
 * simulation → submit with Builder Code suffix. Base Account batches approve + swap atomically.
 * A CoW quote has no transaction: the wallet signs the order instead (see executeSignedOrder).
 *
 * Every re-quote is pinned to the provider the user reviewed and checked against the reviewed
 * amounts, and no calldata reaches the wallet without passing the simulation first, re-quoted or not.
 */
export async function executeTrade(ctx: ExecuteTradeContext, params: ExecuteTradeParams, hooks: ExecuteTradeHooks = {}): Promise<ExecuteTradeResult> {
  const { address, walletClient, publicClient } = ctx;
  if (ctx.chainId !== BASE_CHAIN_ID) throw new ApiError("WRONG_NETWORK", TRADE_ERROR_COPY.WRONG_NETWORK, 400);
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const ask = (provider: TradeProviderId | undefined, strictProvider: boolean | undefined) =>
    apiPost<ExecutableQuoteDTO>("/api/trade/quote", {
      side: params.side,
      assetAddress: params.assetAddress,
      sellAmount: params.sellAmount.toString(),
      payWith: params.payWith,
      provider,
      strictProvider,
      orders: params.orders,
      taker: address,
      recipient: params.recipient,
      slippageBps: params.slippageBps,
      chainId: BASE_CHAIN_ID,
    });

  /** The first quote: the comparison's winner, or the user's pick. */
  const fetchQuote = async (): Promise<ExecutableQuoteDTO> => {
    hooks.onState?.("GETTING_FIRM_QUOTE");
    const q = await ask(params.provider, params.strictProvider);
    hooks.onQuote?.(q);
    return q;
  };

  /**
   * A later quote, after the reviewed one went stale: asked of the reviewed route alone, falling
   * back to the automatic choice only if that route will not answer, and refused (back to review)
   * unless it still describes the reviewed trade.
   */
  const refresh = async (reviewed: ExecutableQuoteDTO): Promise<ExecutableQuoteDTO> => {
    hooks.onState?.("GETTING_FIRM_QUOTE");
    let fresh: ExecutableQuoteDTO;
    try {
      fresh = await ask(reviewed.provider, true);
    } catch {
      fresh = await ask(params.provider, params.strictProvider);
    }
    hooks.onQuote?.(fresh);
    const check = refetchedQuoteAcceptable(reviewed, fresh, slippageBps);
    if (!check.ok) throw reviewAgainError(check.reason, fresh);
    return fresh;
  };

  // A reviewed quote that has since expired is still the trade the user approved: it is refreshed
  // from its own route and held to its own numbers, not replaced by whatever the router picks now.
  const reviewed = params.prefetchedQuote;
  const q = reviewed ? (Date.now() < reviewed.expiresAt ? reviewed : await refresh(reviewed)) : await fetchQuote();
  if (q.balanceInsufficient) throw new ApiError("INSUFFICIENT_BALANCE", TRADE_ERROR_COPY.INSUFFICIENT_BALANCE, 400);

  // The activity record is created only once something was actually submitted to the wallet,
  // so a cancelled review never shows up in Activity.
  const recordId = newId("trade");
  // A signed order has no hash yet; its uid lets the server check with the order book that this
  // wallet is the order's owner, so the record needs no session to be filed.
  const record = (quote: ExecutableQuoteDTO, txHash?: Hash, orderUid?: string) =>
    postTradeRecord({
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
      orderUid,
    });

  if (q.order) {
    const { orderUid } = await executeSignedOrder(ctx, q.order, {
      onState: hooks.onState,
      onApproval: hooks.onApproval,
      onMode: hooks.onMode,
    });
    hooks.onSubmitted?.(undefined, recordId, orderUid);
    void record(q, undefined, orderUid);
    return { txHash: undefined, recordId, quote: q, mode: "order", orderUid };
  }
  if (!q.transaction) throw new ApiError("PROVIDER_UNAVAILABLE", "The provider returned neither a transaction nor an order.", 502);
  let tx: TxQuote = q as TxQuote;

  // Native ETH is sent as tx value: no ERC-20 allowance step.
  const nativeSell = isNativeEth(q.sellToken);
  const spenderOf = (quote: ExecutableQuoteDTO): Address | null => (nativeSell ? null : quote.allowanceSpender);
  const allowanceShort = async (quote: ExecutableQuoteDTO, spender: Address): Promise<boolean> => {
    const current = await publicClient.readContract({ address: quote.sellToken, abi: erc20Abi, functionName: "allowance", args: [address, spender] });
    return current < BigInt(quote.sellAmount);
  };
  /**
   * After a refetch the route may name another spender, or the approval just granted may be
   * short for the new amounts. Either way the wallet is not opened on it: the sheet goes back to
   * review, and the next run approves what the new quote actually needs.
   */
  const assertSpendable = async (fresh: TxQuote): Promise<void> => {
    if (nativeSell) return;
    const spender = spenderOf(fresh);
    if (!spender) throw new ApiError("ROUTE_UNAVAILABLE", "The provider did not return an approval target.", 502);
    if (await allowanceShort(fresh, spender)) throw reviewAgainError("The refreshed route needs a new approval.", fresh);
  };

  let spender = spenderOf(q);
  let needsApproval = !nativeSell && q.allowanceRequired;
  if (spender && !needsApproval) needsApproval = await allowanceShort(q, spender);
  if (needsApproval && !spender) throw new ApiError("ROUTE_UNAVAILABLE", "The provider did not return an approval target.", 502);

  const { atomic, paymaster } = await walletCapabilities(walletClient, address);

  if (needsApproval && atomic && spender) {
    hooks.onMode?.("batched", paymaster);
    if (Date.now() > tx.expiresAt) {
      // The approval is part of the same bundle, so a new spender just means a new approve call.
      tx = asTxQuote(await refresh(tx));
      spender = spenderOf(tx);
      if (!spender) throw new ApiError("ROUTE_UNAVAILABLE", "The provider did not return an approval target.", 502);
    }
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(tx.sellAmount)] });
    // Simulate approve + swap as one bundle (eth_simulateV1) so a revert surfaces before the wallet
    // opens; RPCs without the method skip silently — the wallet itself still simulates.
    await simulateBundle(publicClient, address, [
      { to: tx.sellToken, data: approveData },
      { to: tx.transaction.to, data: tx.transaction.data, value: BigInt(tx.transaction.value) },
    ]);
    hooks.onState?.("AWAITING_WALLET");
    const { id } = await walletClient.sendCalls({
      account: address,
      chain: base,
      forceAtomic: true,
      calls: [
        { to: tx.sellToken, data: withAttribution(approveData) },
        { to: tx.transaction.to, data: withAttribution(tx.transaction.data), value: BigInt(tx.transaction.value) },
      ],
      capabilities: { ...attributionCapabilities(), ...(paymaster ? { paymasterService: { url: publicEnv.paymasterUrl } } : {}) },
    });
    hooks.onState?.("SUBMITTED");
    hooks.onSubmitted?.(undefined, recordId);
    const result = await walletClient.waitForCallsStatus({ id, timeout: 180_000 });
    const hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
    if (result.status === "failure") throw new Error("Batched transaction failed");
    if (hash) void record(tx, hash);
    return { txHash: hash, recordId, quote: tx, mode: "batched" };
  }

  hooks.onMode?.("sequential", false);
  if (needsApproval && spender) {
    const approveData = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, BigInt(tx.sellAmount)] });
    hooks.onState?.("APPROVAL_REQUIRED");
    hooks.onState?.("AWAITING_WALLET");
    const ah = await walletClient.sendTransaction({ account: address, chain: base, to: tx.sellToken, data: withAttribution(approveData) });
    hooks.onApproval?.(ah);
    await publicClient.waitForTransactionReceipt({ hash: ah });
    tx = asTxQuote(await refresh(tx)); // spec §19.4: refresh after approval
    await assertSpendable(tx);
  }
  if (Date.now() > tx.expiresAt) {
    tx = asTxQuote(await refresh(tx));
    await assertSpendable(tx);
  }

  // Simulate before the wallet opens. A stale-price revert earns one refresh, and the refreshed
  // calldata goes through the same simulation; the earlier shape of this re-quoted and fell
  // straight through to the wallet with calldata nothing had checked.
  for (let attempt = 0; ; attempt++) {
    try {
      // `needsApproval`: when we just sent the approval this run, tolerate a stale-allowance revert
      // from an RPC that lags our own approve receipt — that is the "fails on the first try, works on
      // the next" case. Without a fresh approval, a revert is real and surfaces immediately.
      await callAfterApproval(publicClient, address, { to: tx.transaction.to, data: tx.transaction.data as Hex, value: BigInt(tx.transaction.value) }, 4, needsApproval);
      break;
    } catch (simErr) {
      const h = humanizeError(simErr);
      if (attempt === 0 && (h.code === "QUOTE_EXPIRED" || h.code === "SLIPPAGE")) {
        tx = asTxQuote(await refresh(tx));
        await assertSpendable(tx);
        continue;
      }
      throw simErr;
    }
  }

  hooks.onState?.("AWAITING_WALLET");
  const hash = await walletClient.sendTransaction({
    account: address,
    chain: base,
    to: tx.transaction.to,
    data: withAttribution(tx.transaction.data),
    value: BigInt(tx.transaction.value),
  });
  hooks.onState?.("SUBMITTED");
  hooks.onSubmitted?.(hash, recordId);
  void record(tx, hash);
  return { txHash: hash, recordId, quote: tx, mode: "sequential" };
}

/**
 * Simulate a call that depends on an approval we just mined. The fallback transport spreads
 * requests across RPCs, and a public node can lag the approve receipt by a block or two - an
 * "insufficient allowance" revert right after our own approval is stale state, not a real
 * failure, so it retries briefly before surfacing.
 */
export async function callAfterApproval(publicClient: PublicClient, account: Address, call: { to: Address; data: Hex; value?: bigint }, attempts = 4, retryOnRevert = false): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await publicClient.call({ account, to: call.to, data: call.data, value: call.value });
      return;
    } catch (err) {
      const code = humanizeError(err).code;
      // Straight after our own approval a revert is almost always stale allowance state on a lagging
      // RPC. Some routers surface that as a decodable allowance error; others as a bare "execution
      // reverted" (e.g. Uniswap's TransferHelper "STF"). So when the caller says an approval just
      // landed (`retryOnRevert`), retry a generic simulation failure too, not only a decoded one.
      const retriable = code === "ALLOWANCE_REQUIRED" || (retryOnRevert && code === "SIMULATION_FAILED");
      if (retriable && i < attempts) {
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

import { keccak256, toHex, type Address, type Hash, type Hex } from "viem";
import { z } from "zod";
import { BASE_CHAIN_ID, USDC_ADDRESS, isNativeEth } from "@/config/chain";
import type { ExecutableQuote, IndicativeQuote, OrderView, SignedOrderRequest, TradeIntent, TradeProvider, TradeSide } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { integratorFee } from "@/lib/fees";
import { INDICATIVE_TIMEOUT_MS } from "../budget";

/**
 * CoW Protocol on Base (docs.cow.fi). Not a swap transaction: the user signs an EIP-712 order,
 * the order book matches it in a batch auction and the winning solver pays the gas. Keyless.
 *
 * Verified against the live order book on 2026-09-03 (api version v2.377):
 * - quote: POST /quote with sellAmountBeforeFee; `quote.sellAmount + quote.feeAmount` is the amount
 *   sold, `quote.buyAmount` is after fees. Native ETH is refused (InvalidNativeSellToken).
 * - order: feeAmount must be "0"; the fee is taken from the limit price by the solver, so the signed
 *   order sells the full amount for `buyAmount × (1 − slippage)`.
 * - appData: full JSON document (schema 1.3.0 accepted) + its keccak256 as `appDataHash`.
 * - validTo: the quote endpoint accepts up to 3 h; longer limit orders are rejected with ExcessiveValidTo.
 * - The GPv2 contracts share one address on every chain.
 */
export const COW_API = "https://api.cow.fi/base/api/v1";
export const COW_EXPLORER = "https://explorer.cow.fi/base/orders";
export const GPV2_SETTLEMENT: Address = "0x9008D19f58AAbD9eD0D60971565AA8510560ab41";
export const GPV2_VAULT_RELAYER: Address = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
/** Contracts a CoW order may name: the settlement (EIP-712 verifying contract) and the relayer the wallet approves. */
export const EXPECTED_TARGETS: readonly Address[] = [GPV2_SETTLEMENT, GPV2_VAULT_RELAYER];
const APP_CODE = "BStocks";
/** Market orders: how long a signed order may wait for a solver. */
const MARKET_VALID_FOR_S = 30 * 60;
/** The order book's ceiling for quotes; longer limit orders come back with ExcessiveValidTo. */
export const MAX_ORDER_VALID_FOR_S = 3 * 60 * 60;
const QUOTE_TTL_MS = 25_000;
const INDICATIVE_FROM: Address = "0x1111111111111111111111111111111111111111";
const breaker = new CircuitBreaker("cow", 3, 30_000);

const numLike = z.union([z.string(), z.number()]).transform((v) => String(v));

const quoteSchema = z.object({
  quote: z
    .object({
      sellToken: z.string(),
      buyToken: z.string(),
      receiver: z.string().nullable().optional(),
      sellAmount: numLike,
      buyAmount: numLike,
      validTo: z.number(),
      feeAmount: numLike,
      gasAmount: numLike.optional(),
      gasPrice: numLike.optional(),
      kind: z.enum(["sell", "buy"]),
      partiallyFillable: z.boolean(),
    })
    .passthrough(),
  id: z.number().nullable().optional(),
  verified: z.boolean().optional(),
  expiration: z.string().optional(),
});

const orderSchema = z
  .object({
    uid: z.string(),
    owner: z.string().optional(),
    status: z.enum(["presignaturePending", "open", "fulfilled", "cancelled", "expired"]),
    class: z.enum(["market", "limit", "liquidity"]).optional(),
    kind: z.enum(["sell", "buy"]),
    sellToken: z.string(),
    buyToken: z.string(),
    sellAmount: numLike,
    buyAmount: numLike,
    executedSellAmount: numLike.optional(),
    executedSellAmountBeforeFees: numLike.optional(),
    executedBuyAmount: numLike.optional(),
    partiallyFillable: z.boolean(),
    validTo: z.number(),
    creationDate: z.string(),
    invalidated: z.boolean().optional(),
  })
  .passthrough();

const tradeSchema = z.object({ orderUid: z.string(), txHash: z.string().nullable().optional() }).passthrough();

interface CowErrorBody {
  errorType?: string;
  description?: string;
}

/** Order book errors mapped to app error codes; the description is kept for the details panel. */
function cowError(status: number, body: CowErrorBody | null): AppError {
  const type = body?.errorType ?? "";
  const desc = body?.description ?? `http ${status}`;
  const msg = `cow: ${desc}${type ? ` (${type})` : ""}`;
  if (/InsufficientAllowance/.test(type)) return new AppError("ALLOWANCE_REQUIRED", msg, 400);
  if (/InsufficientBalance/.test(type)) return new AppError("INSUFFICIENT_BALANCE", msg, 400);
  if (/NoLiquidity|NoRoute|UnsupportedToken|SellAmountDoesNotCoverFee/.test(type) || status === 404) return new AppError("ROUTE_UNAVAILABLE", msg, 409);
  if (/InvalidSignature|InvalidEip1271Signature|WrongOwner|MissingFrom/.test(type)) return new AppError("SIMULATION_FAILED", `The order signature was not accepted by CoW Protocol (${type}). Nothing was moved.`, 400);
  if (/ExcessiveValidTo/.test(type)) return new AppError("BAD_REQUEST", "CoW Protocol accepts orders valid for at most 3 hours; pick a shorter expiry.", 400);
  if (/InsufficientValidTo|QuoteNotFound|InvalidQuote|QuoteNotVerified/.test(type)) return new AppError("QUOTE_EXPIRED", msg, 409);
  if (/DuplicatedOrder/.test(type)) return new AppError("BAD_REQUEST", "This exact order is already open.", 400);
  if (/TransferSimulationFailed/.test(type)) return new AppError("B20_POLICY_BLOCKED", msg, 400);
  if (status === 429) return new AppError("PROVIDER_UNAVAILABLE", "cow: rate limited", 503);
  if (status >= 500) return new AppError("PROVIDER_UNAVAILABLE", msg, 502);
  return new AppError("PROVIDER_UNAVAILABLE", msg, 502);
}

async function cowRequest<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs = 6_000): Promise<T> {
  return breaker.run(async () => {
    // fetchJson only knows GET/POST; PUT/DELETE are rare (app-data registration, cancellation).
    if (method === "PUT" || method === "DELETE") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${COW_API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
        const text = await res.text();
        const data = text ? (JSON.parse(text) as unknown) : null;
        if (!res.ok) throw cowError(res.status, data as CowErrorBody);
        return data as T;
      } finally {
        clearTimeout(timer);
      }
    }
    const { status, data } = await fetchJson<unknown>(`${COW_API}${path}`, { method, body, timeoutMs, provider: "cow" });
    if (status >= 400) throw cowError(status, data as CowErrorBody);
    return data as T;
  });
}

/* ---------- appData ---------- */

/** Full app-data document (schema 1.3.0) and the bytes32 that goes into the signed order. */
export function appDataFor(orderClass: "market" | "limit", slippageBps: number): { doc: string; hash: Hex } {
  const meta: Record<string, unknown> = { orderClass: { orderClass } };
  if (orderClass === "market") meta.quote = { slippageBips: Math.max(0, Math.min(10_000, Math.round(slippageBps))) };
  // The partner fee lives in the app data, which the quote is asked with, so the quoted amounts are net of it.
  const fee = integratorFee();
  if (fee) meta.partnerFee = { bps: fee.bps, recipient: fee.recipient };
  const doc = JSON.stringify({ version: "1.3.0", appCode: APP_CODE, metadata: meta });
  return { doc, hash: keccak256(toHex(doc)) };
}

const registeredAppData = new Set<string>();
/** Registers the full document once per process so explorers can resolve the hash; best effort. */
async function registerAppData(doc: string, hash: Hex): Promise<void> {
  if (registeredAppData.has(hash)) return;
  try {
    await cowRequest("PUT", `/app_data/${hash}`, { fullAppData: doc }, 4_000);
    registeredAppData.add(hash);
  } catch {
    /* the order carries the full document anyway */
  }
}

/* ---------- typed data ---------- */

const ORDER_TYPES = {
  Order: [
    { name: "sellToken", type: "address" },
    { name: "buyToken", type: "address" },
    { name: "receiver", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "buyAmount", type: "uint256" },
    { name: "validTo", type: "uint32" },
    { name: "appData", type: "bytes32" },
    { name: "feeAmount", type: "uint256" },
    { name: "kind", type: "string" },
    { name: "partiallyFillable", type: "bool" },
    { name: "sellTokenBalance", type: "string" },
    { name: "buyTokenBalance", type: "string" },
  ],
} as const;

export const COW_DOMAIN = { name: "Gnosis Protocol", version: "v2", chainId: BASE_CHAIN_ID, verifyingContract: GPV2_SETTLEMENT } as const;

export const CANCELLATION_TYPES = { OrderCancellations: [{ name: "orderUids", type: "bytes[]" }] } as const;

interface OrderFields {
  sellToken: Address;
  buyToken: Address;
  receiver: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  partiallyFillable: boolean;
}

function signedOrderRequest(fields: OrderFields, orderClass: "market" | "limit", slippageBps: number, quoteId: number | null): SignedOrderRequest {
  const { doc, hash } = appDataFor(orderClass, slippageBps);
  void registerAppData(doc, hash);
  return {
    provider: "cow",
    orderClass,
    typedData: {
      domain: COW_DOMAIN,
      types: { Order: [...ORDER_TYPES.Order] },
      primaryType: "Order",
      message: {
        sellToken: fields.sellToken,
        buyToken: fields.buyToken,
        receiver: fields.receiver,
        sellAmount: fields.sellAmount.toString(),
        buyAmount: fields.buyAmount.toString(),
        validTo: fields.validTo,
        appData: hash,
        feeAmount: "0",
        kind: "sell",
        partiallyFillable: fields.partiallyFillable,
        sellTokenBalance: "erc20",
        buyTokenBalance: "erc20",
      },
    },
    appData: doc,
    appDataHash: hash,
    quoteId,
    allowanceTarget: GPV2_VAULT_RELAYER,
  };
}

/* ---------- quotes ---------- */

interface CowQuote {
  sellAmountTotal: bigint;
  buyAmount: bigint;
  feeAmount: bigint;
  gasAmount: bigint | null;
  gasPrice: bigint | null;
  validTo: number;
  id: number | null;
  verified: boolean;
}

async function fetchQuote(intent: TradeIntent, opts: { from: Address; verified: boolean; validFor: number; timeoutMs: number }): Promise<CowQuote> {
  if (isNativeEth(intent.sellToken)) throw new AppError("ROUTE_UNAVAILABLE", "cow: pay with USDC to use CoW Protocol (native ETH is not accepted as the sell token)", 409);
  const { doc, hash } = appDataFor("market", intent.slippageBps);
  const data = await cowRequest<unknown>(
    "POST",
    "/quote",
    {
      sellToken: intent.sellToken,
      buyToken: intent.buyToken,
      from: opts.from,
      receiver: intent.recipient ?? opts.from,
      kind: "sell",
      sellAmountBeforeFee: intent.sellAmount.toString(),
      validFor: opts.validFor,
      partiallyFillable: false,
      appData: doc,
      appDataHash: hash,
      priceQuality: opts.verified ? "verified" : "optimal",
      signingScheme: "eip712",
      timeout: Math.max(500, opts.timeoutMs - 500),
    },
    opts.timeoutMs,
  );
  const parsed = quoteSchema.safeParse(data);
  if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "cow: unexpected quote schema", 502);
  const q = parsed.data.quote;
  return {
    sellAmountTotal: BigInt(q.sellAmount) + BigInt(q.feeAmount),
    buyAmount: BigInt(q.buyAmount),
    feeAmount: BigInt(q.feeAmount),
    gasAmount: q.gasAmount ? BigInt(q.gasAmount.split(".")[0]!) : null,
    gasPrice: q.gasPrice ? BigInt(q.gasPrice.split(".")[0]!) : null,
    validTo: q.validTo,
    id: parsed.data.id ?? null,
    verified: parsed.data.verified ?? false,
  };
}

function normalize(intent: TradeIntent, q: CowQuote): IndicativeQuote {
  return {
    provider: "cow",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: q.sellAmountTotal,
    buyAmount: q.buyAmount,
    minBuyAmount: (q.buyAmount * BigInt(10_000 - intent.slippageBps)) / 10_000n,
    gas: null,
    gasPrice: null,
    // The solver pays the gas; the fee is already inside buyAmount. Nothing is charged on top.
    totalNetworkFeeWei: 0n,
    liquidityAvailable: q.buyAmount > 0n,
    allowanceTarget: GPV2_VAULT_RELAYER,
    route: [{ source: "CoW solvers", proportionBps: 10_000 }],
    issues: { allowanceRequired: false, allowanceSpender: GPV2_VAULT_RELAYER, balanceInsufficient: false, simulationIncomplete: true },
    fetchedAt: Date.now(),
    integratorFeeBps: integratorFee()?.bps,
  };
}

export class CowTradeProvider implements TradeProvider {
  readonly id = "cow" as const;

  /**
   * The indicative budget is the comparison's 2.5 s less a margin for the round trip, and the order
   * book is told to stop solving 500 ms before that (`timeout` in the body). Raising it to the
   * 2.8 s a full solver pass wants would only help if the comparison waited that long; it does not,
   * so a longer budget here would be an answer nobody is still listening for.
   */
  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    const q = await fetchQuote(intent, { from: intent.taker ?? INDICATIVE_FROM, verified: false, validFor: MARKET_VALID_FOR_S, timeoutMs: INDICATIVE_TIMEOUT_MS - 100 });
    const n = normalize(intent, q);
    if (!n.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "cow: no liquidity", 409);
    return n;
  }

  /** Executable = the order the wallet will sign; sells the full amount for buyAmount less slippage. */
  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    const q = await fetchQuote(intent, { from: intent.taker, verified: false, validFor: MARKET_VALID_FOR_S, timeoutMs: 8_000 });
    const base = normalize(intent, q);
    if (!base.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "cow: no liquidity", 409);
    const order = signedOrderRequest(
      { sellToken: intent.sellToken, buyToken: intent.buyToken, receiver: intent.recipient ?? intent.taker, sellAmount: q.sellAmountTotal, buyAmount: base.minBuyAmount!, validTo: q.validTo, partiallyFillable: false },
      "market",
      intent.slippageBps,
      q.id,
    );
    return { ...base, transaction: null, order, quoteId: q.id !== null ? String(q.id) : null, expiresAt: Date.now() + QUOTE_TTL_MS };
  }
}

export const cowProvider = new CowTradeProvider();

/* ---------- limit orders ---------- */

/**
 * A limit order is the same intent with the user's own buyAmount and a longer validity; it is
 * partially fillable so a thin pool can fill it in pieces. No quote is needed to build it.
 */
export function prepareLimitOrder(params: { sellToken: Address; buyToken: Address; sellAmount: bigint; minBuyAmount: bigint; owner: Address; receiver?: Address; validForSeconds: number; partiallyFillable?: boolean }): SignedOrderRequest {
  const validFor = Math.min(MAX_ORDER_VALID_FOR_S, Math.max(60, Math.round(params.validForSeconds)));
  const validTo = Math.floor(Date.now() / 1000) + validFor;
  return signedOrderRequest({ sellToken: params.sellToken, buyToken: params.buyToken, receiver: params.receiver ?? params.owner, sellAmount: params.sellAmount, buyAmount: params.minBuyAmount, validTo, partiallyFillable: params.partiallyFillable ?? true }, "limit", 0, null);
}

/* ---------- submission, status, cancellation ---------- */

export type CowSigningScheme = "eip712" | "eip1271" | "presign";

export async function submitOrder(order: SignedOrderRequest, signature: Hex, signingScheme: CowSigningScheme, from: Address): Promise<string> {
  const m = order.typedData.message;
  const uid = await cowRequest<string>(
    "POST",
    "/orders",
    {
      sellToken: m.sellToken,
      buyToken: m.buyToken,
      receiver: m.receiver,
      sellAmount: m.sellAmount,
      buyAmount: m.buyAmount,
      validTo: m.validTo,
      appData: order.appData,
      appDataHash: order.appDataHash,
      feeAmount: "0",
      kind: m.kind,
      partiallyFillable: m.partiallyFillable,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
      signingScheme,
      signature,
      from,
      quoteId: order.quoteId ?? undefined,
    },
    10_000,
  );
  metrics.count("cow.order.submitted", true, order.orderClass);
  return uid;
}

function sideOf(sellToken: string): TradeSide {
  return sellToken.toLowerCase() === USDC_ADDRESS.toLowerCase() ? "buy" : "sell";
}

function toView(o: z.infer<typeof orderSchema>, txHash: Hash | null): OrderView {
  const side = sideOf(o.sellToken);
  const status = o.invalidated && o.status === "open" ? "cancelled" : o.status;
  return {
    uid: o.uid,
    owner: (o.owner as Address | undefined) ?? null,
    provider: "cow",
    status,
    orderClass: o.class ?? "market",
    side,
    assetAddress: (side === "buy" ? o.buyToken : o.sellToken) as Address,
    sellToken: o.sellToken as Address,
    buyToken: o.buyToken as Address,
    sellAmount: o.sellAmount,
    buyAmount: o.buyAmount,
    executedSellAmount: o.executedSellAmountBeforeFees ?? o.executedSellAmount ?? "0",
    executedBuyAmount: o.executedBuyAmount ?? "0",
    partiallyFillable: o.partiallyFillable,
    validTo: o.validTo,
    createdAt: Date.parse(o.creationDate) || Date.now(),
    txHash,
    explorerUrl: `${COW_EXPLORER}/${o.uid}`,
  };
}

async function settlementTx(uid: string): Promise<Hash | null> {
  try {
    const trades = await cowRequest<unknown[]>("GET", `/trades?orderUid=${uid}`, undefined, 5_000);
    const parsed = z.array(tradeSchema).safeParse(trades);
    const hash = parsed.success ? parsed.data.find((t) => t.txHash)?.txHash : null;
    return hash ? (hash as Hash) : null;
  } catch {
    return null;
  }
}

export async function getOrder(uid: string): Promise<OrderView> {
  const data = await cowRequest<unknown>("GET", `/orders/${uid}`, undefined, 6_000);
  const parsed = orderSchema.safeParse(data);
  if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "cow: unexpected order schema", 502);
  const filled = BigInt(parsed.data.executedBuyAmount ?? "0") > 0n;
  return toView(parsed.data, filled ? await settlementTx(uid) : null);
}

export async function listOrders(owner: Address, limit = 20): Promise<OrderView[]> {
  const data = await cowRequest<unknown[]>("GET", `/account/${owner}/orders?limit=${Math.min(100, limit)}`, undefined, 6_000);
  const parsed = z.array(orderSchema).safeParse(data);
  if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "cow: unexpected orders schema", 502);
  // Settlement hashes only for filled orders, in parallel, best effort.
  return Promise.all(parsed.data.map(async (o) => toView(o, BigInt(o.executedBuyAmount ?? "0") > 0n ? await settlementTx(o.uid) : null)));
}

/** Offchain cancellation for EOAs (EIP-712 OrderCancellations). Smart wallets invalidate onchain instead. */
export async function cancelOrders(uids: string[], signature: Hex, signingScheme: "eip712" | "ethsign"): Promise<void> {
  await cowRequest("DELETE", "/orders", { orderUids: uids, signature, signingScheme }, 8_000);
  metrics.count("cow.order.cancelled", true, String(uids.length));
}

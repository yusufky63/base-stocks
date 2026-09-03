import { decodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { z } from "zod";
import { serverEnv } from "@/config/env";
import { EXECUTABLE_QUOTE_TTL_MS } from "@/config/chain";
import type { ExecutableQuote, IndicativeQuote, TradeIntent, TradeProvider } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { CircuitBreaker, fetchJson } from "@/lib/http";

/**
 * Uniswap Trading API (Base) — proxy-approval flow, no Permit2 signatures.
 * Docs: https://developers.uniswap.org/docs/trading/swapping-api/getting-started
 *       https://developers.uniswap.org/docs/trading/swapping-api/concepts/no-permit2-workflow
 * With the `x-permit2-disabled` header every call runs against Uniswap's approval proxy:
 *   check_approval → (approve proxy) → quote (permitData null) → swap (tx to the proxy).
 * That maps 1:1 onto the app's pipeline (exact approval to the returned spender, re-quote, simulate,
 * send). UniswapX is not available in this mode; routes are Uniswap v2/v3/v4 pools only, so for
 * tokenized stocks this is a fallback behind KyberSwap, which also sees Aerodrome.
 * Verified 2026-09-02: quote + swap for USDC → NVDAc return a tx to proxy 0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9.
 */
const BASE_URL = "https://trade-api.gateway.uniswap.org/v1";
const breaker = new CircuitBreaker("uniswap", 3, 20_000);

const amountSchema = z.object({ amount: z.string(), token: z.string().optional(), minimumAmount: z.string().optional(), maximumAmount: z.string().optional() });
const quoteResponseSchema = z.object({
  requestId: z.string().optional(),
  routing: z.string(),
  permitData: z.unknown().nullable().optional(),
  isTokenApprovalApplicable: z.boolean().optional(),
  quote: z
    .object({
      input: amountSchema,
      output: amountSchema,
      gasFee: z.string().optional(),
      gasFeeUSD: z.union([z.string(), z.number()]).optional(),
      gasUseEstimate: z.union([z.string(), z.number()]).optional(),
      priceImpact: z.number().optional(),
      quoteId: z.string().optional(),
      routeString: z.string().optional(),
      route: z.array(z.array(z.object({ type: z.string().optional(), fee: z.union([z.string(), z.number()]).optional() }).passthrough())).optional(),
    })
    .passthrough(),
});
const swapResponseSchema = z.object({
  requestId: z.string().optional(),
  gasFee: z.string().optional(),
  swap: z.object({ to: z.string(), from: z.string().optional(), data: z.string(), value: z.string().optional(), gasLimit: z.string().optional(), chainId: z.number().optional(), maxFeePerGas: z.string().optional() }),
});
const approvalResponseSchema = z.object({ approval: z.object({ to: z.string(), data: z.string() }).nullable().optional() });
const errorSchema = z.object({ errorCode: z.string().optional(), detail: z.string().optional() });

function headers(): Record<string, string> {
  return { "x-api-key": serverEnv().UNISWAP_API_KEY ?? "", "x-permit2-disabled": "true" };
}

function toBig(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return BigInt(typeof v === "number" ? Math.round(v) : v);
  } catch {
    return null;
  }
}

async function post<T>(path: string, body: unknown, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
  return breaker.run(async () => {
    const { status, data } = await fetchJson<unknown>(`${BASE_URL}${path}`, { method: "POST", body, headers: headers(), timeoutMs, provider: "uniswap" });
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "uniswap: rate limited", 503);
    if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `uniswap: http ${status}`, 502);
    if (status >= 400) {
      const err = errorSchema.safeParse(data);
      const detail = err.success ? `${err.data.errorCode ?? ""} ${err.data.detail ?? ""}`.trim() : `http ${status}`;
      // Validation errors and "no route" both mean this provider cannot serve the intent; not an outage.
      throw new AppError("ROUTE_UNAVAILABLE", `uniswap: ${detail}`, 409);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", `uniswap: unexpected schema for ${path}`, 502);
    return parsed.data;
  });
}

/** The proxy the API expects approvals for, decoded from its own approve calldata (never hardcoded). */
async function approvalSpender(intent: TradeIntent, taker: Address): Promise<Address | null> {
  try {
    const r = await post("/check_approval", { walletAddress: taker, token: intent.sellToken, amount: intent.sellAmount.toString(), chainId: intent.chainId }, approvalResponseSchema, 5_000);
    if (!r.approval?.data) return null;
    const decoded = decodeFunctionData({ abi: erc20Abi, data: r.approval.data as Hex });
    if (decoded.functionName !== "approve") return null;
    return decoded.args[0] as Address;
  } catch {
    return null;
  }
}

async function fetchQuote(intent: TradeIntent, taker: Address): Promise<z.infer<typeof quoteResponseSchema>> {
  const body = {
    type: "EXACT_INPUT",
    amount: intent.sellAmount.toString(),
    tokenInChainId: intent.chainId,
    tokenOutChainId: intent.chainId,
    tokenIn: intent.sellToken,
    tokenOut: intent.buyToken,
    swapper: taker,
    routingPreference: "BEST_PRICE",
    slippageTolerance: Math.max(0.01, intent.slippageBps / 100),
  };
  return post("/quote", body, quoteResponseSchema, 6_000);
}

/** The API needs a real-looking swapper for indicative quotes; low addresses are rejected. */
const PROBE_TAKER: Address = "0x1111111111111111111111111111111111111111";

function normalize(q: z.infer<typeof quoteResponseSchema>, intent: TradeIntent, spender: Address | null): IndicativeQuote {
  const buyAmount = toBig(q.quote.output.amount) ?? 0n;
  const gas = toBig(q.quote.gasUseEstimate);
  const fee = toBig(q.quote.gasFee);
  const route = (q.quote.route ?? []).flat().map((hop) => ({ source: `uniswap-${hop.type ?? "pool"}${hop.fee ? ` ${Number(hop.fee) / 10_000}%` : ""}`, proportionBps: null }));
  return {
    provider: "uniswap",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: toBig(q.quote.input.amount) ?? intent.sellAmount,
    buyAmount,
    minBuyAmount: toBig(q.quote.output.minimumAmount),
    gas,
    gasPrice: gas !== null && fee !== null && gas > 0n ? fee / gas : null,
    totalNetworkFeeWei: fee,
    liquidityAvailable: buyAmount > 0n,
    allowanceTarget: spender,
    route: route.length ? route : [{ source: `uniswap ${q.routing.toLowerCase()}`, proportionBps: null }],
    issues: {
      allowanceRequired: q.isTokenApprovalApplicable ?? true,
      allowanceSpender: spender,
      balanceInsufficient: false,
      simulationIncomplete: true,
    },
    fetchedAt: Date.now(),
  };
}

export class UniswapTradeProvider implements TradeProvider {
  readonly id = "uniswap" as const;

  static isConfigured(): boolean {
    return !!serverEnv().UNISWAP_API_KEY;
  }

  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    const taker = intent.taker ?? PROBE_TAKER;
    const [q, spender] = await Promise.all([fetchQuote(intent, taker), approvalSpender(intent, taker)]);
    const out = normalize(q, intent, spender);
    if (!out.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "uniswap: no route for this amount", 409);
    return out;
  }

  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    if (intent.recipient && intent.recipient.toLowerCase() !== intent.taker.toLowerCase()) {
      throw new AppError("ROUTE_UNAVAILABLE", "uniswap: custom recipients are not supported in the proxy flow", 409);
    }
    const [q, spender] = await Promise.all([fetchQuote(intent, intent.taker), approvalSpender(intent, intent.taker)]);
    const base = normalize(q, intent, spender);
    if (!base.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "uniswap: no route for this amount", 409);
    const built = await post("/swap", { quote: q.quote, simulateTransaction: false }, swapResponseSchema, 7_000);
    const to = built.swap.to as Address;
    return {
      ...base,
      // The proxy that receives the swap is the same contract the approval targets; keep them consistent.
      allowanceTarget: base.allowanceTarget ?? to,
      issues: { ...base.issues, allowanceSpender: base.issues.allowanceSpender ?? to },
      gas: toBig(built.swap.gasLimit) ?? base.gas,
      transaction: {
        to,
        data: built.swap.data as Hex,
        value: toBig(built.swap.value) ?? 0n,
        gas: toBig(built.swap.gasLimit) ?? base.gas,
        gasPrice: base.gasPrice,
      },
      quoteId: q.quote.quoteId ?? q.requestId ?? null,
      expiresAt: Date.now() + EXECUTABLE_QUOTE_TTL_MS,
    };
  }
}

export const uniswapProvider = new UniswapTradeProvider();

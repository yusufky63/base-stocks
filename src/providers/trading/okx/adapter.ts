import type { Address, Hex } from "viem";
import { z } from "zod";
import type { ExecutableQuote, IndicativeQuote, TradeIntent, TradeProvider } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { BASE_CHAIN_INDEX, okxConfigured, okxRequest, okxStatus } from "@/providers/okx/client";

/**
 * OKX DEX aggregator (Onchain OS) on Base. Comparison + execution provider when the project's API
 * key is entitled to the aggregator service; otherwise the provider is skipped and the Status page
 * shows the OKX error code. Native ETH is `0xeeee…eeee` on OKX as well.
 * Docs: https://web3.okx.com/build/dev-docs/dex-api  (v6 aggregator: quote · swap · approve-transaction).
 * v5 answered 50050 "deprecated" on 2026-09-03; v6 renames `slippage` → `slippagePercent` (percent, "0.5"),
 * `priceImpactPercentage` → `priceImpactPercent`, drops `chainId`, and flattens `dexRouterList` to one
 * `dexProtocol` object per hop. `estimateGasFee` is a gas amount, not wei.
 */
const QUOTE_TTL_MS = 8_000;
const numLike = z.union([z.string(), z.number()]).transform((v) => String(v));

const dexProtocolSchema = z.object({ dexName: z.string().optional(), percent: numLike.optional() }).passthrough();
// v6: one `dexProtocol` object per hop; v5 nested `subRouterList[].dexProtocol[]` — accept both.
const dexRouterSchema = z
  .object({
    routerPercent: numLike.optional(),
    dexProtocol: z.union([dexProtocolSchema, z.array(dexProtocolSchema)]).optional(),
    subRouterList: z.array(z.object({ dexProtocol: z.array(dexProtocolSchema).optional() }).passthrough()).optional(),
  })
  .passthrough();

const quoteSchema = z
  .object({
    fromTokenAmount: numLike.optional(),
    toTokenAmount: numLike.optional(),
    estimateGasFee: numLike.optional(),
    priceImpactPercent: numLike.optional(),
    dexRouterList: z.array(dexRouterSchema).optional(),
  })
  .passthrough();

const swapSchema = z
  .object({
    routerResult: quoteSchema.optional(),
    tx: z
      .object({
        to: z.string(),
        data: z.string(),
        value: numLike.optional(),
        gas: numLike.optional(),
        gasPrice: numLike.optional(),
        minReceiveAmount: numLike.optional(),
      })
      .passthrough(),
  })
  .passthrough();

const approveSchema = z.object({ dexContractAddress: z.string().optional(), data: z.string().optional() }).passthrough();

function toBig(v: string | undefined): bigint | null {
  if (!v) return null;
  try {
    return BigInt(v.split(".")[0]!);
  } catch {
    return null;
  }
}

function fills(q: z.infer<typeof quoteSchema>): Array<{ source: string; proportionBps: number | null }> {
  const out: Array<{ source: string; proportionBps: number | null }> = [];
  for (const r of q.dexRouterList ?? []) {
    const direct = r.dexProtocol === undefined ? [] : Array.isArray(r.dexProtocol) ? r.dexProtocol : [r.dexProtocol];
    const nested = (r.subRouterList ?? []).flatMap((s) => s.dexProtocol ?? []);
    const protocols = direct.length ? direct : nested;
    const names = protocols.map((d) => d.dexName ?? "unknown");
    const pctRaw = r.routerPercent ?? (direct.length === 1 ? direct[0]!.percent : undefined);
    const pct = pctRaw ? Math.round(Number(pctRaw) * 100) : null;
    out.push({ source: names.length ? names.join(" → ") : "okx", proportionBps: pct });
  }
  return out;
}

function baseQuery(intent: TradeIntent): Record<string, string> {
  return { chainIndex: BASE_CHAIN_INDEX, fromTokenAddress: intent.sellToken, toTokenAddress: intent.buyToken, amount: intent.sellAmount.toString() };
}

function normalize(q: z.infer<typeof quoteSchema>, intent: TradeIntent, spender: Address | null, gasPrice: bigint | null = null): IndicativeQuote {
  const buy = toBig(q.toTokenAmount) ?? 0n;
  const gasEstimate = toBig(q.estimateGasFee);
  const feeWei = gasEstimate !== null && gasPrice !== null ? gasEstimate * gasPrice : null;
  return {
    provider: "okx",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: toBig(q.fromTokenAmount) ?? intent.sellAmount,
    buyAmount: buy,
    minBuyAmount: null,
    gas: null,
    gasPrice: null,
    totalNetworkFeeWei: feeWei,
    liquidityAvailable: buy > 0n,
    allowanceTarget: spender,
    route: fills(q),
    issues: { allowanceRequired: false, allowanceSpender: spender, balanceInsufficient: false, simulationIncomplete: true },
    fetchedAt: Date.now(),
  };
}

async function spenderFor(intent: TradeIntent): Promise<Address | null> {
  if (intent.sellToken.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") return null;
  const data = await okxRequest<unknown[]>("GET", "/api/v6/dex/aggregator/approve-transaction", { query: { chainIndex: BASE_CHAIN_INDEX, tokenContractAddress: intent.sellToken, approveAmount: intent.sellAmount.toString() } });
  const parsed = approveSchema.safeParse(Array.isArray(data) ? data[0] : data);
  return parsed.success && parsed.data.dexContractAddress ? (parsed.data.dexContractAddress as Address) : null;
}

export class OkxTradeProvider implements TradeProvider {
  readonly id = "okx" as const;

  static isConfigured(): boolean {
    return okxConfigured();
  }

  /** Skip the provider while OKX reports no entitlement; re-tried by the hourly status probe. */
  static isUsable(): boolean {
    const s = okxStatus();
    // After a "no access" answer, stay out of the comparison for an hour, then try again.
    return okxConfigured() && (s.state !== "no-access" || Date.now() - (s.checkedAt ?? 0) > 3_600_000);
  }

  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    const data = await okxRequest<unknown[]>("GET", "/api/v6/dex/aggregator/quote", { query: baseQuery(intent) });
    const parsed = quoteSchema.safeParse(Array.isArray(data) ? data[0] : data);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "okx: unexpected quote schema", 502);
    const q = normalize(parsed.data, intent, null);
    if (!q.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "okx: no liquidity", 409);
    return q;
  }

  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    const [data, spender] = await Promise.all([
      okxRequest<unknown[]>("GET", "/api/v6/dex/aggregator/swap", { query: { ...baseQuery(intent), slippagePercent: (intent.slippageBps / 100).toString(), userWalletAddress: intent.taker, swapReceiverAddress: intent.recipient ?? intent.taker } }),
      spenderFor(intent).catch(() => null),
    ]);
    const parsed = swapSchema.safeParse(Array.isArray(data) ? data[0] : data);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "okx: unexpected swap schema", 502);
    const native = intent.sellToken.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    // The approval spender (approve-transaction) is not the router `tx.to`; never fall back to it.
    if (!native && !spender) throw new AppError("PROVIDER_UNAVAILABLE", "okx: approval spender unavailable", 502);
    const gas = toBig(parsed.data.tx.gas);
    const gasPrice = toBig(parsed.data.tx.gasPrice);
    const base = normalize(parsed.data.routerResult ?? {}, intent, spender, gasPrice);
    if (!base.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "okx: no liquidity", 409);
    return {
      ...base,
      minBuyAmount: toBig(parsed.data.tx.minReceiveAmount) ?? (base.buyAmount * BigInt(10_000 - intent.slippageBps)) / 10_000n,
      gas,
      gasPrice,
      totalNetworkFeeWei: base.totalNetworkFeeWei ?? (gas !== null && gasPrice !== null ? gas * gasPrice : null),
      transaction: { to: parsed.data.tx.to as Address, data: parsed.data.tx.data as Hex, value: toBig(parsed.data.tx.value) ?? 0n, gas, gasPrice },
      quoteId: null,
      expiresAt: Date.now() + QUOTE_TTL_MS,
    };
  }
}

export const okxProvider = new OkxTradeProvider();

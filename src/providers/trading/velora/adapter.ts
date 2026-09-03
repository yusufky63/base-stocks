import type { Address, Hex } from "viem";
import { z } from "zod";
import type { ExecutableQuote, IndicativeQuote, TradeIntent, TradeProvider } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { CircuitBreaker, fetchJson } from "@/lib/http";
import { BASE_CHAIN_ID, USDC_DECIMALS } from "@/config/chain";

/**
 * Velora (formerly ParaSwap) aggregator, API v6.2 — keyless, supports Base.
 * Docs: https://developers.velora.xyz/ — GET /prices then POST /transactions/{chainId}.
 * Third route provider for diversity; allowance target is the TokenTransferProxy from the price route.
 */
const BASE_URL = "https://api.paraswap.io";
const PARTNER = "bstocks";
const breaker = new CircuitBreaker("velora", 3, 30_000);
const ROUTE_TTL_MS = 20_000;

const bigStr = z.union([z.string(), z.number()]).transform((v) => String(v));

const priceRouteSchema = z
  .object({
    srcAmount: bigStr,
    destAmount: bigStr,
    tokenTransferProxy: z.string(),
    contractAddress: z.string().optional(),
    gasCost: bigStr.optional(),
    gasCostUSD: bigStr.optional(),
    bestRoute: z
      .array(
        z
          .object({
            percent: z.number().optional(),
            swaps: z.array(z.object({ swapExchanges: z.array(z.object({ exchange: z.string(), percent: z.number().optional() }).passthrough()).optional() }).passthrough()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const pricesSchema = z.object({ priceRoute: priceRouteSchema.optional(), error: z.string().optional() });
const txSchema = z.object({ to: z.string(), data: z.string(), value: bigStr.optional(), gas: bigStr.optional(), gasPrice: bigStr.optional(), error: z.string().optional() });

function decimalsFor(intent: TradeIntent, token: Address): number {
  if (token.toLowerCase() === intent.sellToken.toLowerCase()) return intent.sellTokenDecimals ?? USDC_DECIMALS;
  return intent.buyTokenDecimals ?? 8;
}

async function fetchPriceRoute(intent: TradeIntent) {
  const p = new URLSearchParams({
    srcToken: intent.sellToken,
    destToken: intent.buyToken,
    amount: intent.sellAmount.toString(),
    srcDecimals: String(decimalsFor(intent, intent.sellToken)),
    destDecimals: String(decimalsFor(intent, intent.buyToken)),
    side: "SELL",
    network: String(BASE_CHAIN_ID),
    version: "6.2",
    partner: PARTNER,
  });
  if (intent.taker) p.set("userAddress", intent.taker);
  return breaker.run(async () => {
    const { status, data } = await fetchJson<unknown>(`${BASE_URL}/prices?${p}`, { timeoutMs: 5_000, provider: "velora" });
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "velora: rate limited", 503);
    if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `velora: http ${status}`, 502);
    const parsed = pricesSchema.safeParse(data);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "velora: unexpected prices schema", 502);
    if (!parsed.data.priceRoute) throw new AppError("ROUTE_UNAVAILABLE", `velora: ${parsed.data.error ?? "no route"}`, 409);
    return parsed.data.priceRoute;
  });
}

function normalize(route: z.infer<typeof priceRouteSchema>, intent: TradeIntent): IndicativeQuote {
  const buyAmount = BigInt(route.destAmount);
  const fills: IndicativeQuote["route"] = [];
  for (const leg of route.bestRoute ?? []) {
    for (const swap of leg.swaps ?? []) {
      for (const ex of swap.swapExchanges ?? []) fills.push({ source: ex.exchange, proportionBps: ex.percent !== undefined ? Math.round(ex.percent * 100) : null });
    }
  }
  const gas = route.gasCost ? BigInt(route.gasCost) : null;
  return {
    provider: "velora",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: BigInt(route.srcAmount),
    buyAmount,
    minBuyAmount: (buyAmount * BigInt(10_000 - intent.slippageBps)) / 10_000n,
    gas,
    gasPrice: null,
    totalNetworkFeeWei: null,
    liquidityAvailable: buyAmount > 0n,
    allowanceTarget: route.tokenTransferProxy as Address,
    route: fills,
    issues: { allowanceRequired: false, allowanceSpender: route.tokenTransferProxy as Address, balanceInsufficient: false, simulationIncomplete: true },
    fetchedAt: Date.now(),
  };
}

export class VeloraTradeProvider implements TradeProvider {
  readonly id = "velora" as const;

  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    const route = await fetchPriceRoute(intent);
    const q = normalize(route, intent);
    if (!q.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "velora: no liquidity", 409);
    return q;
  }

  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    const route = await fetchPriceRoute(intent);
    const base = normalize(route, intent);
    const body = {
      srcToken: intent.sellToken,
      destToken: intent.buyToken,
      srcAmount: route.srcAmount,
      slippage: intent.slippageBps,
      priceRoute: route,
      userAddress: intent.taker,
      receiver: intent.recipient ?? undefined,
      partner: PARTNER,
      srcDecimals: decimalsFor(intent, intent.sellToken),
      destDecimals: decimalsFor(intent, intent.buyToken),
    };
    const tx = await breaker.run(async () => {
      const { status, data } = await fetchJson<unknown>(`${BASE_URL}/transactions/${BASE_CHAIN_ID}?ignoreChecks=true`, { method: "POST", body, timeoutMs: 8_000, provider: "velora" });
      if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `velora: http ${status}`, 502);
      const parsed = txSchema.safeParse(data);
      if (!parsed.success || parsed.data.error) throw new AppError("ROUTE_UNAVAILABLE", `velora: ${parsed.success ? parsed.data.error : "unexpected tx schema"}`, 409);
      return parsed.data;
    });
    return {
      ...base,
      transaction: { to: tx.to as Address, data: tx.data as Hex, value: tx.value ? BigInt(tx.value) : 0n, gas: tx.gas ? BigInt(tx.gas) : base.gas, gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : null },
      quoteId: null,
      expiresAt: Date.now() + ROUTE_TTL_MS,
    };
  }
}

export const veloraProvider = new VeloraTradeProvider();

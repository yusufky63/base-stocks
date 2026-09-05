import type { Address, Hex } from "viem";
import { serverEnv } from "@/config/env";
import { USDC_ADDRESS } from "@/config/chain";
import { integratorFee } from "@/lib/fees";
import type { ExecutableQuote, IndicativeQuote, TradeIntent, TradeProvider } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { CircuitBreaker, fetchJson } from "@/lib/http";
import { kyberBuildResponseSchema, kyberRoutesResponseSchema, type KyberRouteSummary } from "./schemas";

/**
 * KyberSwap Aggregator API (Base). Fallback / comparison provider.
 * Docs: https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps
 * Routes must not be cached for more than ~5-10s; we re-fetch before building.
 */
const BASE_URL = "https://aggregator-api.kyberswap.com/base/api/v1";
const ROUTE_TTL_MS = 8_000;
const breaker = new CircuitBreaker("kyber", 3, 20_000);

function headers(): Record<string, string> {
  const env = serverEnv();
  const h: Record<string, string> = { "x-client-id": env.KYBER_CLIENT_ID };
  if (env.KYBER_API_KEY) h["x-api-key"] = env.KYBER_API_KEY;
  return h;
}

function toBig(v: string | undefined | null): bigint | null {
  if (!v) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function fills(summary: KyberRouteSummary): Array<{ source: string; proportionBps: number | null }> {
  const paths = summary.route ?? [];
  if (paths.length === 0) return [];
  const per = Math.floor(10_000 / paths.length);
  const out: Array<{ source: string; proportionBps: number | null }> = [];
  for (const path of paths) {
    const src = path.map((s) => s.exchange ?? s.poolType ?? "unknown").join(" → ");
    out.push({ source: src, proportionBps: per });
  }
  return out;
}

async function fetchRoute(intent: TradeIntent): Promise<{ summary: KyberRouteSummary; router: Address }> {
  const p = new URLSearchParams({
    tokenIn: intent.sellToken,
    tokenOut: intent.buyToken,
    amountIn: intent.sellAmount.toString(),
    gasInclude: "true",
  });
  // The fee is taken in USDC whichever side it is on, so it reads as a dollar line; the route
  // summary returned here carries it (`extraFee`) into the build step and the quoted output is net of it.
  const fee = integratorFee();
  if (fee) {
    p.set("chargeFeeBy", intent.buyToken.toLowerCase() === USDC_ADDRESS.toLowerCase() ? "currency_out" : "currency_in");
    p.set("feeAmount", String(fee.bps));
    p.set("isInBps", "true");
    p.set("feeReceiver", fee.recipient);
  }
  return breaker.run(async () => {
    const { status, data } = await fetchJson<unknown>(`${BASE_URL}/routes?${p}`, { headers: headers(), timeoutMs: 5_000, provider: "kyber" });
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "kyber: rate limited", 503);
    if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `kyber: http ${status}`, 502);
    const parsed = kyberRoutesResponseSchema.safeParse(data);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "kyber: unexpected routes schema", 502);
    if (parsed.data.code !== 0 || !parsed.data.data?.routeSummary) {
      throw new AppError("ROUTE_UNAVAILABLE", `kyber: ${parsed.data.message ?? "no route"}`, 409);
    }
    return { summary: parsed.data.data.routeSummary, router: parsed.data.data.routerAddress as Address };
  });
}

function normalize(summary: KyberRouteSummary, router: Address, intent: TradeIntent): IndicativeQuote {
  const gas = toBig(summary.gas);
  const gasPrice = toBig(summary.gasPrice);
  return {
    provider: "kyber",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: toBig(summary.amountIn) ?? intent.sellAmount,
    buyAmount: toBig(summary.amountOut) ?? 0n,
    minBuyAmount: null,
    gas,
    gasPrice,
    totalNetworkFeeWei: gas !== null && gasPrice !== null ? gas * gasPrice : null,
    liquidityAvailable: (toBig(summary.amountOut) ?? 0n) > 0n,
    allowanceTarget: router,
    route: fills(summary),
    issues: {
      // Kyber does not report allowance/balance issues; the client checks allowance onchain.
      allowanceRequired: false,
      allowanceSpender: router,
      balanceInsufficient: false,
      simulationIncomplete: true,
    },
    fetchedAt: Date.now(),
    integratorFeeBps: integratorFee()?.bps,
  };
}

export class KyberTradeProvider implements TradeProvider {
  readonly id = "kyber" as const;

  static isConfigured(): boolean {
    return true; // public API with client id; API key optional
  }

  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    const { summary, router } = await fetchRoute(intent);
    const q = normalize(summary, router, intent);
    if (!q.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "kyber: no liquidity", 409);
    return q;
  }

  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    const { summary, router } = await fetchRoute(intent);
    const base = normalize(summary, router, intent);
    const body = {
      routeSummary: summary,
      sender: intent.taker,
      recipient: intent.recipient ?? intent.taker,
      slippageTolerance: intent.slippageBps,
      deadline: Math.floor(Date.now() / 1000) + 120,
      source: serverEnv().KYBER_CLIENT_ID,
      enableGasEstimation: false,
    };
    const built = await breaker.run(async () => {
      const { status, data } = await fetchJson<unknown>(`${BASE_URL}/route/build`, {
        method: "POST",
        body,
        headers: headers(),
        timeoutMs: 7_000,
        provider: "kyber",
      });
      if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `kyber: http ${status}`, 502);
      const parsed = kyberBuildResponseSchema.safeParse(data);
      if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "kyber: unexpected build schema", 502);
      if (parsed.data.code !== 0 || !parsed.data.data) {
        throw new AppError("ROUTE_UNAVAILABLE", `kyber: ${parsed.data.message ?? "build failed"}`, 409);
      }
      return parsed.data.data;
    });
    const minBuy = (base.buyAmount * BigInt(10_000 - intent.slippageBps)) / 10_000n;
    return {
      ...base,
      buyAmount: toBig(built.amountOut) ?? base.buyAmount,
      minBuyAmount: minBuy,
      gas: toBig(built.gas) ?? base.gas,
      transaction: {
        to: built.routerAddress as Address,
        data: built.data as Hex,
        value: toBig(built.transactionValue) ?? 0n,
        gas: toBig(built.gas) ?? base.gas,
        gasPrice: base.gasPrice,
      },
      quoteId: summary.routeID ?? null,
      expiresAt: Date.now() + ROUTE_TTL_MS,
    };
  }
}

export const kyberProvider = new KyberTradeProvider();

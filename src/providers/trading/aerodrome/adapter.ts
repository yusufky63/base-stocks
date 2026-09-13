import { encodeFunctionData, parseAbi, type Address } from "viem";
import type { ExecutableQuote, IndicativeQuote, TradeIntent, TradeProvider } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { AERODROME_V2_FACTORY } from "@/providers/earn/aerodrome/adapter";

/**
 * Aerodrome direct route (last-resort fallback, no external API): quotes with the Router's
 * `getAmountsOut` and builds `swapExactTokensForTokens` calldata for the volatile pool.
 * Verified onchain: Router.defaultFactory() == v2 PoolFactory 0x420D…40Da.
 */
export const AERODROME_ROUTER: Address = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
/** Contracts an Aerodrome quote may send the wallet to or ask it to approve: the Router, which is also the spender. */
export const EXPECTED_TARGETS: readonly Address[] = [AERODROME_ROUTER];

const routerAbi = parseAbi([
  "struct Route { address from; address to; bool stable; address factory; }",
  "function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);

async function quote(intent: TradeIntent): Promise<bigint> {
  const client = getServerPublicClient();
  const routes = [{ from: intent.sellToken, to: intent.buyToken, stable: false, factory: AERODROME_V2_FACTORY }];
  try {
    const amounts = await client.readContract({ address: AERODROME_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [intent.sellAmount, routes] });
    return amounts[amounts.length - 1] ?? 0n;
  } catch {
    throw new AppError("ROUTE_UNAVAILABLE", "aerodrome: no pool for this pair", 409);
  }
}

function normalize(intent: TradeIntent, out: bigint): IndicativeQuote {
  return {
    provider: "aerodrome",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: intent.sellAmount,
    buyAmount: out,
    minBuyAmount: (out * BigInt(10_000 - intent.slippageBps)) / 10_000n,
    gas: 220_000n,
    gasPrice: null,
    totalNetworkFeeWei: null,
    liquidityAvailable: out > 0n,
    allowanceTarget: AERODROME_ROUTER,
    route: [{ source: "Aerodrome v2 (direct)", proportionBps: 10_000 }],
    issues: { allowanceRequired: false, allowanceSpender: AERODROME_ROUTER, balanceInsufficient: false, simulationIncomplete: true },
    fetchedAt: Date.now(),
  };
}

export class AerodromeTradeProvider implements TradeProvider {
  readonly id = "aerodrome" as const;

  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    if (intent.sellToken.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") throw new AppError("ROUTE_UNAVAILABLE", "aerodrome: native ETH sells are routed by the aggregators", 409);
    const out = await quote(intent);
    if (out === 0n) throw new AppError("ROUTE_UNAVAILABLE", "aerodrome: no liquidity", 409);
    return normalize(intent, out);
  }

  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    const out = await quote(intent);
    if (out === 0n) throw new AppError("ROUTE_UNAVAILABLE", "aerodrome: no liquidity", 409);
    const base = normalize(intent, out);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
    const data = encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactTokensForTokens",
      args: [intent.sellAmount, base.minBuyAmount ?? 0n, [{ from: intent.sellToken, to: intent.buyToken, stable: false, factory: AERODROME_V2_FACTORY }], intent.recipient ?? intent.taker, deadline],
    });
    return { ...base, transaction: { to: AERODROME_ROUTER, data, value: 0n, gas: base.gas, gasPrice: null }, quoteId: null, expiresAt: Date.now() + 60_000 };
  }
}

export const aerodromeTradeProvider = new AerodromeTradeProvider();

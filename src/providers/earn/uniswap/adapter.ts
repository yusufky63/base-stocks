import { parseAbi, zeroAddress, type Address } from "viem";
import type { EarnExecution, EarnIntent, EarnOpportunity, EarnProvider } from "@/domain/earn";
import { USDC_ADDRESS, USDC_DECIMALS, WETH_ADDRESS } from "@/config/chain";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { cached, TTL } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { getEthUsd } from "@/services/price-service";

/**
 * Uniswap v3 pool discovery on Base (onchain, no SDK): factory `getPool(token, quote, fee)` for the
 * standard fee tiers against USDC and WETH. Community pools exist for the live tokenized stocks
 * (tens of thousands of dollars, far below Aerodrome); they are shown as link-out liquidity venues
 * only when they hold real balances. Base's docs mention Uniswap only as an agent plugin; the
 * recommended trading path for B20 stays an aggregator, which already routes through these pools.
 */
export const UNISWAP_V3_FACTORY_BASE: Address = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
const FEE_TIERS = [100, 500, 3000, 10000] as const;
const MIN_LIQUIDITY_USD = 500;

const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const QUOTES: Array<{ address: Address; symbol: string; decimals: number }> = [
  { address: USDC_ADDRESS, symbol: "USDC", decimals: USDC_DECIMALS },
  { address: WETH_ADDRESS, symbol: "WETH", decimals: 18 },
];

interface FoundPool {
  pool: Address;
  quote: (typeof QUOTES)[number];
  fee: number;
}

async function findPools(asset: Address): Promise<FoundPool[]> {
  return cached(`uniswap:pools:${asset.toLowerCase()}`, TTL.earn, async () => {
    const client = getServerPublicClient();
    const calls: Array<Omit<FoundPool, "pool">> = [];
    const contracts = QUOTES.flatMap((q) =>
      FEE_TIERS.map((fee) => {
        calls.push({ quote: q, fee });
        return { address: UNISWAP_V3_FACTORY_BASE, abi: factoryAbi, functionName: "getPool" as const, args: [asset, q.address, fee] as const };
      }),
    );
    const res = await client.multicall({ contracts, allowFailure: true });
    const found: FoundPool[] = [];
    res.forEach((r, i) => {
      if (r.status === "success" && typeof r.result === "string" && r.result !== zeroAddress) found.push({ pool: r.result as Address, ...calls[i]! });
    });
    return found;
  });
}

export class UniswapEarnProvider implements EarnProvider {
  readonly id = "uniswap" as const;

  async discover(asset: Address, _user?: Address, priceUsd?: number | null): Promise<EarnOpportunity[]> {
    void _user;
    try {
      const pools = await findPools(asset);
      if (pools.length === 0) return [];
      const client = getServerPublicClient();
      const contracts = pools.flatMap((p) => [
        { address: asset, abi: erc20Abi, functionName: "balanceOf" as const, args: [p.pool] as const },
        { address: p.quote.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [p.pool] as const },
      ]);
      const [bal, ethUsd] = await Promise.all([client.multicall({ contracts, allowFailure: true }), getEthUsd().catch(() => null)]);
      const now = Date.now();
      return pools
        .map((p, i) => {
          const assetBal = bal[i * 2]?.status === "success" ? (bal[i * 2]!.result as bigint) : 0n;
          const quoteBal = bal[i * 2 + 1]?.status === "success" ? (bal[i * 2 + 1]!.result as bigint) : 0n;
          const assetUsd = priceUsd ? (Number(assetBal) / 1e8) * priceUsd : null; // B20 decimals are 8 (verified)
          const quoteUsd = p.quote.symbol === "USDC" ? Number(quoteBal) / 10 ** USDC_DECIMALS : ethUsd !== null ? (Number(quoteBal) / 1e18) * ethUsd : null;
          const liquidityUsd = assetUsd !== null && quoteUsd !== null ? assetUsd + quoteUsd : quoteUsd !== null ? quoteUsd * 2 : undefined;
          return {
            id: `uniswap:v3:${p.pool.toLowerCase()}`,
            provider: "uniswap" as const,
            assetAddress: asset,
            type: "liquidity" as const,
            title: `Uniswap v3 ${p.quote.symbol} pool · ${(p.fee / 10_000).toFixed(2).replace(/0$/, "")}% fee`,
            liquidityUsd,
            riskLabel: "higher" as const,
            dataTimestamp: now,
            url: `https://app.uniswap.org/explore/pools/base/${p.pool}`,
            risks: [
              "Variable fees: earnings depend on trading volume and are not guaranteed.",
              "Price / range risk: providing liquidity changes your exposure as prices move (impermanent loss).",
              "Concentrated positions can fall out of range and stop earning.",
              "Small pool: prices here can deviate from deeper venues; aggregators only use it for part of a route.",
            ],
            inApp: false,
            metadata: { pool: p.pool, fee: p.fee, quote: p.quote.symbol },
          };
        })
        .filter((o) => o.liquidityUsd === undefined || o.liquidityUsd >= MIN_LIQUIDITY_USD)
        .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    } catch (err) {
      metrics.count("uniswap.discover", false, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async prepare(_input: EarnIntent): Promise<EarnExecution> {
    void _input;
    throw new AppError("PROVIDER_UNAVAILABLE", "Uniswap positions are managed in the Uniswap app.", 501);
  }
}

export const uniswapProvider = new UniswapEarnProvider();

import { parseAbi, zeroAddress, type Address } from "viem";
import type { EarnExecution, EarnIntent, EarnOpportunity, EarnProvider } from "@/domain/earn";
import { USDC_ADDRESS, USDC_DECIMALS, WETH_ADDRESS } from "@/config/chain";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { cached, TTL } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { getEthUsd } from "@/services/price-service";
import { getDexPools } from "../geckoterminal-pools";
import { estimateFeeApyPct, liquidityRiskLabel } from "../fee-apy";

/**
 * Aerodrome liquidity discovery (onchain, no SDK).
 * Checks the v2 (AMM) factory and BOTH Slipstream (CL) factories for pools pairing the B20
 * asset with USDC or WETH. Absent pool => no opportunity shown.
 * Addresses verified on Base mainnet: v2 factory via `allPoolsLength()`; the two CL factories via
 * `tickSpacings()` / `poolImplementation()` / `voter()` — the newer one (0xf8f2…) holds the deep
 * NVDAc/USDC pool (tick spacing 10) that aggregators route through.
 */
export const AERODROME_V2_FACTORY: Address = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
export const AERODROME_CL_FACTORIES: Address[] = ["0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef", "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A"];

const v2FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, bool stable) view returns (address)"]);
const clFactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)",
  "function tickSpacings() view returns (int24[])",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const QUOTES: Array<{ address: Address; symbol: string; decimals: number }> = [
  { address: USDC_ADDRESS, symbol: "USDC", decimals: USDC_DECIMALS },
  { address: WETH_ADDRESS, symbol: "WETH", decimals: 18 },
];

interface FoundPool {
  pool: Address;
  kind: "v2-volatile" | "v2-stable" | "cl";
  quote: (typeof QUOTES)[number];
  tickSpacing?: number;
  factory: Address;
}

const DEFAULT_SPACINGS = [1, 10, 50, 100, 200, 500, 2000];

async function findPools(asset: Address): Promise<FoundPool[]> {
  return cached(`aero:pools:${asset.toLowerCase()}`, TTL.earn, async () => {
    const client = getServerPublicClient();
    const spacingsByFactory = await Promise.all(
      AERODROME_CL_FACTORIES.map(async (f) => {
        try {
          const s = await client.readContract({ address: f, abi: clFactoryAbi, functionName: "tickSpacings" });
          return s.length > 0 ? s.map(Number) : DEFAULT_SPACINGS;
        } catch {
          return DEFAULT_SPACINGS;
        }
      }),
    );
    type V2Call = { address: Address; abi: typeof v2FactoryAbi; functionName: "getPool"; args: readonly [Address, Address, boolean] };
    type ClCall = { address: Address; abi: typeof clFactoryAbi; functionName: "getPool"; args: readonly [Address, Address, number] };
    const calls: Array<Omit<FoundPool, "pool">> = [];
    const contracts: Array<V2Call | ClCall> = [];
    for (const q of QUOTES) {
      for (const stable of [false, true]) {
        calls.push({ kind: stable ? "v2-stable" : "v2-volatile", quote: q, factory: AERODROME_V2_FACTORY });
        contracts.push({ address: AERODROME_V2_FACTORY, abi: v2FactoryAbi, functionName: "getPool", args: [asset, q.address, stable] });
      }
      AERODROME_CL_FACTORIES.forEach((factory, fi) => {
        for (const ts of spacingsByFactory[fi]!) {
          calls.push({ kind: "cl", quote: q, tickSpacing: ts, factory });
          contracts.push({ address: factory, abi: clFactoryAbi, functionName: "getPool", args: [asset, q.address, ts] });
        }
      });
    }
    const res = await client.multicall({ contracts, allowFailure: true });
    const found: FoundPool[] = [];
    const seen = new Set<string>();
    res.forEach((r, i) => {
      if (r.status === "success" && typeof r.result === "string" && r.result !== zeroAddress && !seen.has(r.result.toLowerCase())) {
        seen.add(r.result.toLowerCase());
        found.push({ pool: r.result as Address, ...calls[i]! });
      }
    });
    return found;
  });
}

export class AerodromeEarnProvider implements EarnProvider {
  readonly id = "aerodrome" as const;

  async discover(asset: Address, _user?: Address, priceUsd?: number | null): Promise<EarnOpportunity[]> {
    void _user;
    try {
      const pools = await findPools(asset);
      if (pools.length === 0) return [];
      const client = getServerPublicClient();
      // Liquidity: token balances held by the pool (works for both v2 reserves and CL pools).
      const contracts = pools.flatMap((p) => [
        { address: asset, abi: erc20Abi, functionName: "balanceOf" as const, args: [p.pool] as const },
        { address: p.quote.address, abi: erc20Abi, functionName: "balanceOf" as const, args: [p.pool] as const },
      ]);
      const feeAbi = parseAbi(["function fee() view returns (uint24)"]);
      const clPools = pools.filter((p) => p.kind === "cl");
      const [bal, ethUsd, fees, gt] = await Promise.all([
        client.multicall({ contracts, allowFailure: true }),
        getEthUsd().catch(() => null),
        client.multicall({ contracts: clPools.map((p) => ({ address: p.pool, abi: feeAbi, functionName: "fee" as const })), allowFailure: true }).catch(() => []),
        getDexPools(asset).catch(() => []),
      ]);
      const feeByPool = new Map(clPools.map((p, i) => [p.pool.toLowerCase(), fees[i]?.status === "success" ? Number(fees[i]!.result) / 1e6 : null]));
      const volumeByPool = new Map(gt.map((p) => [p.address.toLowerCase(), p.volume24hUsd]));
      const now = Date.now();
      const out = pools.map((p, i) => {
        const assetBal = bal[i * 2]?.status === "success" ? (bal[i * 2]!.result as bigint) : 0n;
        const quoteBal = bal[i * 2 + 1]?.status === "success" ? (bal[i * 2 + 1]!.result as bigint) : 0n;
        const assetUsd = priceUsd ? (Number(assetBal) / 1e8) * priceUsd : null; // B20 decimals are 8 (verified)
        const quoteUsd = p.quote.symbol === "USDC" ? Number(quoteBal) / 10 ** USDC_DECIMALS : ethUsd !== null ? (Number(quoteBal) / 1e18) * ethUsd : null;
        const liquidityUsd = assetUsd !== null && quoteUsd !== null ? assetUsd + quoteUsd : quoteUsd !== null ? quoteUsd * 2 : undefined;
        const label = p.kind === "cl" ? `Concentrated · tick ${p.tickSpacing}` : p.kind === "v2-stable" ? "Stable AMM" : "Volatile AMM";
        const variableApy = p.kind === "cl" ? estimateFeeApyPct(volumeByPool.get(p.pool.toLowerCase()), feeByPool.get(p.pool.toLowerCase()), liquidityUsd) : undefined;
        return {
          id: `aerodrome:${p.kind}:${p.pool.toLowerCase()}`,
          provider: "aerodrome" as const,
          assetAddress: asset,
          type: "liquidity" as const,
          title: `Aerodrome ${p.quote.symbol} pool · ${label}`,
          liquidityUsd,
          variableApy,
          riskLabel: liquidityRiskLabel(p.quote.symbol, liquidityUsd),
          dataTimestamp: now,
          url: `https://aerodrome.finance/deposit?token0=${asset}&token1=${p.quote.address}&type=${p.kind === "cl" ? p.tickSpacing : p.kind === "v2-stable" ? 0 : -1}&chain=8453`,
          risks: [
            "Variable fees: earnings depend on trading volume and are not guaranteed.",
            "Price / range risk: providing liquidity changes your exposure as prices move (impermanent loss).",
            "Position complexity: concentrated positions can fall out of range and stop earning.",
            "Incentives (if any) can change or end at any time.",
          ],
          inApp: false,
          metadata: { pool: p.pool, kind: p.kind, quote: p.quote.symbol, tickSpacing: p.tickSpacing ?? null, factory: p.factory },
        };
      });
      // Deepest pools first; dust pools (< $50) are hidden so an empty legacy pool never outranks the real one.
      return out.filter((o) => o.liquidityUsd === undefined || o.liquidityUsd >= 50).sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    } catch (err) {
      metrics.count("aerodrome.discover", false, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  async prepare(_input: EarnIntent): Promise<EarnExecution> {
    void _input;
    throw new AppError("PROVIDER_UNAVAILABLE", "Aerodrome deposits are not enabled in this version. Use the Aerodrome app link.", 501);
  }
}

export const aerodromeProvider = new AerodromeEarnProvider();

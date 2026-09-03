import { encodeFunctionData, erc20Abi, parseAbi, type Address } from "viem";
import type { EarnExecution, EarnIntent, EarnOpportunity, EarnProvider } from "@/domain/earn";
import { aavePoolAbi, MAX_UINT256 } from "@/lib/earn/abis";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { cached, TTL } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";

/**
 * Aave V3 on Base — runtime discovery only.
 * Addresses from bgd-labs/aave-address-book (AaveV3Base). A B20 asset is an opportunity
 * ONLY if it is listed in `getReservesList()` and the reserve is active and not frozen.
 */
export const AAVE_V3_BASE_POOL: Address = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
export const AAVE_V3_BASE_DATA_PROVIDER: Address = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A";

const poolAbi = parseAbi(["function getReservesList() view returns (address[])"]);
const dataProviderAbi = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
]);

const RAY = 10n ** 27n;

async function reservesList(): Promise<Set<string>> {
  return cached("aave:reserves", TTL.earn, async () => {
    const list = await getServerPublicClient().readContract({ address: AAVE_V3_BASE_POOL, abi: poolAbi, functionName: "getReservesList" });
    return new Set(list.map((a) => a.toLowerCase()));
  });
}

export class AaveEarnProvider implements EarnProvider {
  readonly id = "aave" as const;

  async discover(asset: Address): Promise<EarnOpportunity[]> {
    try {
      const reserves = await reservesList();
      if (!reserves.has(asset.toLowerCase())) return [];
      const client = getServerPublicClient();
      const [cfg, data] = await client.multicall({
        contracts: [
          { address: AAVE_V3_BASE_DATA_PROVIDER, abi: dataProviderAbi, functionName: "getReserveConfigurationData", args: [asset] },
          { address: AAVE_V3_BASE_DATA_PROVIDER, abi: dataProviderAbi, functionName: "getReserveData", args: [asset] },
        ],
        allowFailure: true,
      });
      if (cfg.status !== "success") return [];
      const [, , , , , , , , isActive, isFrozen] = cfg.result;
      if (!isActive || isFrozen) return [];
      let apy: number | undefined;
      let ts = Date.now();
      if (data.status === "success") {
        const liquidityRate = data.result[5];
        apy = (Number((liquidityRate * 1_000_000n) / RAY) / 1_000_000) * 100;
        ts = Number(data.result[11]) * 1000;
      }
      return [
        {
          id: `aave:supply:${asset.toLowerCase()}`,
          provider: "aave",
          assetAddress: asset,
          type: "supply",
          title: "Aave V3 supply",
          variableApy: apy,
          riskLabel: "medium",
          dataTimestamp: ts,
          url: `https://app.aave.com/reserve-overview/?underlyingAsset=${asset.toLowerCase()}&marketName=proto_base_v3`,
          risks: [
            "Variable supply rate: the displayed APY changes with market utilization and is not guaranteed.",
            "Protocol and smart-contract risk of Aave V3.",
            "Withdrawals depend on available liquidity in the reserve.",
          ],
          inApp: true,
          metadata: { pool: AAVE_V3_BASE_POOL },
        },
      ];
    } catch (err) {
      metrics.count("aave.discover", false, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /** supply(asset, amount, onBehalfOf, 0) after an exact approval; withdraw(asset, amount|max, to). */
  async prepare(input: EarnIntent): Promise<EarnExecution> {
    const asset = input.opportunityId.replace(/^aave:supply:/, "") as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(asset)) throw new AppError("BAD_REQUEST", "Unknown Aave reserve", 400);
    const decimals = await getServerPublicClient().readContract({ address: asset, abi: erc20Abi, functionName: "decimals" });
    if (input.action === "deposit") {
      if (input.amount === "max" || input.amount <= 0n) throw new AppError("BAD_REQUEST", "Enter a supply amount.", 400);
      return {
        spender: AAVE_V3_BASE_POOL,
        underlying: asset,
        underlyingDecimals: decimals,
        description: "Supply to Aave V3",
        calls: [
          { kind: "approve", to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [AAVE_V3_BASE_POOL, input.amount] }), value: 0n },
          { kind: "deposit", to: AAVE_V3_BASE_POOL, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "supply", args: [asset, input.amount, input.user, 0] }), value: 0n },
        ],
      };
    }
    const amount = input.amount === "max" ? MAX_UINT256 : input.amount;
    return {
      underlying: asset,
      underlyingDecimals: decimals,
      description: "Withdraw from Aave V3",
      calls: [{ kind: "withdraw", to: AAVE_V3_BASE_POOL, data: encodeFunctionData({ abi: aavePoolAbi, functionName: "withdraw", args: [asset, amount, input.user] }), value: 0n }],
    };
  }
}

export const aaveProvider = new AaveEarnProvider();

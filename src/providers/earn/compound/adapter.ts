import { encodeFunctionData, erc20Abi, parseAbi, type Address } from "viem";
import type { EarnExecution, EarnIntent, EarnOpportunity, EarnProvider } from "@/domain/earn";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { cached, TTL } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { MAX_UINT256 } from "@/lib/earn/abis";
import { perSecondRateToAprPct, perSecondRateToApyPct } from "@/lib/earn/rates";

/**
 * Compound v3 (Comet) USDC market on Base — runtime discovery only.
 * Verified onchain: baseToken() == USDC, getSupplyRate(getUtilization()) ≈ 4.4% APR.
 * A Comet market exists only for its base asset, so this adapter answers for USDC alone.
 */
export const COMET_USDC_BASE: Address = "0xb125E6687d4313864e53df431d5425969c15Eb2F";

export const cometAbi = parseAbi([
  "function baseToken() view returns (address)",
  "function getUtilization() view returns (uint256)",
  "function getSupplyRate(uint256 utilization) view returns (uint64)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function supply(address asset, uint256 amount)",
  "function withdraw(address asset, uint256 amount)",
]);

export class CompoundEarnProvider implements EarnProvider {
  readonly id = "compound" as const;

  async discover(asset: Address): Promise<EarnOpportunity[]> {
    try {
      const data = await cached(`compound:usdc`, TTL.earn, async () => {
        const client = getServerPublicClient();
        const [baseToken, utilization, totalSupply] = await Promise.all([
          client.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "baseToken" }),
          client.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "getUtilization" }),
          client.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "totalSupply" }),
        ]);
        const rate = await client.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "getSupplyRate", args: [utilization] });
        // The rate is per second, scaled by 1e18; interest accrues every second, so the comparable
        // figure is the compounded one. The linear APR is kept in the metadata for the curious.
        const perSecond = Number(rate) / 1e18;
        return { baseToken, apy: perSecondRateToApyPct(perSecond), aprPct: perSecondRateToAprPct(perSecond), tvlUsd: Number(totalSupply) / 1e6, at: Date.now() };
      });
      if (data.baseToken.toLowerCase() !== asset.toLowerCase()) return [];
      return [
        {
          id: `compound:comet:${COMET_USDC_BASE.toLowerCase()}`,
          provider: "compound",
          assetAddress: asset,
          type: "supply",
          title: "Compound v3 USDC",
          variableApy: data.apy,
          tvlUsd: data.tvlUsd,
          riskLabel: "medium",
          dataTimestamp: data.at,
          url: "https://app.compound.finance/markets/usdc-basemainnet",
          risks: ["Variable supply rate driven by market utilization; not guaranteed.", "Protocol and smart-contract risk of Compound v3.", "Withdrawals depend on available liquidity in the market."],
          inApp: true,
          metadata: { comet: COMET_USDC_BASE, aprPct: data.aprPct, rateBasis: "apy" },
        },
      ];
    } catch (err) {
      metrics.count("compound.discover", false, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /** supply(asset, amount) after an exact approval; withdraw(asset, amount|max). */
  async prepare(input: EarnIntent): Promise<EarnExecution> {
    const client = getServerPublicClient();
    const asset = await client.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "baseToken" });
    const decimals = await client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" });
    if (input.action === "deposit") {
      if (input.amount === "max" || input.amount <= 0n) throw new AppError("BAD_REQUEST", "Enter a supply amount.", 400);
      return {
        spender: COMET_USDC_BASE,
        underlying: asset,
        underlyingDecimals: decimals,
        description: "Supply to Compound v3",
        calls: [
          { kind: "approve", to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [COMET_USDC_BASE, input.amount] }), value: 0n },
          { kind: "deposit", to: COMET_USDC_BASE, data: encodeFunctionData({ abi: cometAbi, functionName: "supply", args: [asset, input.amount] }), value: 0n },
        ],
      };
    }
    const amount = input.amount === "max" ? MAX_UINT256 : input.amount;
    return {
      underlying: asset,
      underlyingDecimals: decimals,
      description: "Withdraw from Compound v3",
      calls: [{ kind: "withdraw", to: COMET_USDC_BASE, data: encodeFunctionData({ abi: cometAbi, functionName: "withdraw", args: [asset, amount] }), value: 0n }],
    };
  }
}

export const compoundProvider = new CompoundEarnProvider();

"use client";

import { useReadContracts } from "wagmi";
import { erc20Abi, type Address } from "viem";
import { b20AssetAbi } from "@/lib/b20/abi";
import { USDC_ADDRESS, BASE_CHAIN_ID } from "@/config/chain";

/** Live balances for the trade panel: USDC + raw/scaled B20 balance (one multicall). */
export function useTokenBalances(owner?: Address, asset?: Address) {
  const enabled = !!owner && !!asset;
  const q = useReadContracts({
    allowFailure: true,
    query: { enabled, refetchInterval: 30_000 },
    contracts: enabled
      ? [
          { address: USDC_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [owner!], chainId: BASE_CHAIN_ID },
          { address: asset!, abi: b20AssetAbi, functionName: "balanceOf", args: [owner!], chainId: BASE_CHAIN_ID },
          { address: asset!, abi: b20AssetAbi, functionName: "scaledBalanceOf", args: [owner!], chainId: BASE_CHAIN_ID },
        ]
      : [],
  });
  const val = (i: number) => (q.data?.[i]?.status === "success" ? (q.data[i]!.result as bigint) : 0n);
  return {
    usdc: val(0),
    raw: val(1),
    scaled: val(2),
    isLoading: q.isLoading,
    refetch: q.refetch,
  };
}

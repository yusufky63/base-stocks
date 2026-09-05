"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { BASE_CHAIN_ID } from "@/config/chain";
import { walletCapabilities } from "@/lib/trade/execute";

/**
 * What the connected wallet can do with a batch (EIP-5792), asked once per wallet. It decides how
 * a basket is confirmed: one signature for everything, or one approval and then leg by leg.
 */
export function useWalletBatching() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId: BASE_CHAIN_ID });
  return useQuery({
    queryKey: ["wallet-batching", address ?? null, walletClient?.uid ?? null],
    queryFn: () => walletCapabilities(walletClient!, address!),
    enabled: !!walletClient && !!address,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

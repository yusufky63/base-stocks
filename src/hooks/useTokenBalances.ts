"use client";

import { useCallback, useMemo } from "react";
import { type Address } from "viem";
import type { PortfolioSnapshot } from "@/lib/client-api";
import { USDC_ADDRESS } from "@/config/chain";
import { usePortfolio } from "./queries";

export interface TokenBalances {
  usdc: bigint;
  raw: bigint;
  scaled: bigint;
}

/** Amounts cross the wire as decimal strings (JSON has no bigint); anything unparseable is zero. */
function big(v: string | undefined | null): bigint {
  if (!v) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * The three balances a trade surface needs, taken from the portfolio snapshot.
 *
 * Pure so it can be tested without a wallet: the hook below is only the plumbing.
 */
export function pickBalances(snapshot: Pick<PortfolioSnapshot, "usdcBalance" | "holdings"> | undefined, asset?: Address): TokenBalances {
  const usdc = big(snapshot?.usdcBalance);
  if (!asset) return { usdc, raw: 0n, scaled: 0n };
  // Callers that pass USDC as the asset (Earn, the plan executor) mean the USDC balance itself.
  if (asset.toLowerCase() === USDC_ADDRESS.toLowerCase()) return { usdc, raw: usdc, scaled: usdc };
  const holding = snapshot?.holdings.find((h) => h.assetAddress.toLowerCase() === asset.toLowerCase());
  // A stock the wallet does not hold is absent from the snapshot, which is a zero balance.
  return { usdc, raw: big(holding?.rawBalance), scaled: big(holding?.scaledBalance) };
}

/**
 * Balances for the trade surfaces, read from the portfolio snapshot the app already loads.
 *
 * All three numbers are already in `/api/portfolio/[address]`, so the browser used to fetch the
 * same state twice: once from the server and once as its own multicall against the RPC, every
 * thirty seconds, per visitor. That second read is what made RPC cost grow with the number of
 * people on the site rather than with the work being done. Reading the snapshot instead costs
 * nothing extra — react-query shares it by key across every component that asks — and the server
 * caches it per wallet.
 *
 * `refetch` re-reads the snapshot, so callers that refresh after a trade still do.
 */
export function useTokenBalances(owner?: Address, asset?: Address) {
  const { data, isLoading, refetch } = usePortfolio(owner);
  const balances = useMemo(() => pickBalances(data, asset), [data, asset]);
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  return { ...balances, isLoading: isLoading && !data, refetch: refresh };
}

import type { Address } from "viem";

/**
 * Concentrated-liquidity position managers on Base that BStocks tracks and manages.
 * Client-safe (addresses only); the read side lives in services/lp-positions-service.
 * Verified on Base mainnet 2026-09-02.
 */
export interface LpManagerInfo {
  id: "uniswap-v3" | "aerodrome-cl" | "aerodrome-cl-legacy";
  label: string;
  provider: "uniswap" | "aerodrome";
  kind: "v3" | "cl";
  npm: Address;
  factory: Address;
}

export const LP_MANAGER_INFO: LpManagerInfo[] = [
  { id: "aerodrome-cl", label: "Aerodrome Slipstream", provider: "aerodrome", kind: "cl", npm: "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53", factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" },
  { id: "aerodrome-cl-legacy", label: "Aerodrome Slipstream (v1)", provider: "aerodrome", kind: "cl", npm: "0x827922686190790b37229fd06084350E74485b72", factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" },
  { id: "uniswap-v3", label: "Uniswap v3", provider: "uniswap", kind: "v3", npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" },
];

export function lpManagerById(id: string): LpManagerInfo | undefined {
  return LP_MANAGER_INFO.find((m) => m.id === id);
}

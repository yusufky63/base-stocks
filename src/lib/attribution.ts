import { Attribution } from "ox/erc8021";
import { concatHex, type Hex } from "viem";
import { publicEnv } from "@/config/env";

/**
 * Base Builder Codes (ERC-8021) attribution.
 * Centralized: every app-originated transaction passes its calldata through `withAttribution`.
 * Docs: https://docs.base.org/specifications/builder-codes/for-app-developers
 */
let cachedSuffix: Hex | null | undefined;

export function getBuilderDataSuffix(): Hex | null {
  if (cachedSuffix !== undefined) return cachedSuffix;
  const code = publicEnv.builderCode.trim();
  if (!code) {
    cachedSuffix = null;
    return null;
  }
  try {
    cachedSuffix = Attribution.toDataSuffix({ codes: [code] });
  } catch {
    cachedSuffix = null;
  }
  return cachedSuffix;
}

/** Append the builder-code suffix to calldata when configured. Idempotent. */
export function withAttribution(data: Hex): Hex {
  const suffix = getBuilderDataSuffix();
  if (!suffix) return data;
  if (data.toLowerCase().endsWith(suffix.slice(2).toLowerCase())) return data;
  return concatHex([data, suffix]);
}

export function isAttributionEnabled(): boolean {
  return getBuilderDataSuffix() !== null;
}

/**
 * EIP-5792 batches: smart wallets (Base Account) wrap the calls in a UserOperation, and indexers
 * read the suffix at the end of that outer callData. The `dataSuffix` capability asks the wallet
 * to append it there; `optional: true` keeps wallets without the capability working.
 * Spread into `sendCalls({ capabilities })` next to paymasterService.
 */
export function attributionCapabilities(): { dataSuffix: { value: Hex; optional: true } } | Record<string, never> {
  const suffix = getBuilderDataSuffix();
  return suffix ? { dataSuffix: { value: suffix, optional: true } } : {};
}

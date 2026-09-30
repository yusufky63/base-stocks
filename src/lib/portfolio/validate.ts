import type { Address } from "viem";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation } from "@/domain/portfolio";
import { allAssetEntries, isCuratedAsset } from "@/lib/b20/registry";

/**
 * Allocation validation, shared by the Build and Automate screens and the server routes. Kept in
 * `lib` with nothing but the registry behind it: it used to live in `portfolio-service`, and every
 * client screen that imported it pulled the database layer and the trade router into its bundle.
 */
export interface AllocationValidation {
  ok: boolean;
  errors: string[];
  normalized: Allocation[];
}

function symbolFor(key: string): string {
  const entry = allAssetEntries().find((e) => e.address.toLowerCase() === key);
  return entry?.underlying ?? `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Sums to 10,000 bps, unique canonical assets, positive weights. */
export function validateAllocations(input: Allocation[], opts?: { allowedAssets?: Set<string> }): AllocationValidation {
  const errors: string[] = [];
  const seen = new Set<string>();
  const normalized: Allocation[] = [];
  for (const a of input) {
    const key = a.assetAddress === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : a.assetAddress.toLowerCase();
    if (!Number.isInteger(a.weightBps) || a.weightBps <= 0 || a.weightBps > TOTAL_BPS) {
      const label = key === USDC_ALLOCATION_KEY ? "USDC" : symbolFor(key);
      errors.push(a.weightBps <= 0 ? `${label} has no weight yet: give it a share above 0% or remove it.` : `${label} needs a weight between 0.01% and 100%.`);
      continue;
    }
    if (seen.has(key)) {
      errors.push(`Duplicate allocation for ${key}.`);
      continue;
    }
    seen.add(key);
    if (key !== USDC_ALLOCATION_KEY) {
      if (!isCuratedAsset(key)) {
        errors.push(`${key} is not a verified Coinbase Tokenized Stock.`);
        continue;
      }
      if (opts?.allowedAssets && !opts.allowedAssets.has(key)) {
        errors.push(`${key} is not available for trading.`);
        continue;
      }
    }
    normalized.push({ assetAddress: key === USDC_ALLOCATION_KEY ? USDC_ALLOCATION_KEY : (a.assetAddress as Address), weightBps: a.weightBps });
  }
  const sum = normalized.reduce((s, a) => s + a.weightBps, 0);
  if (sum !== TOTAL_BPS) errors.push(`Allocations must total 100% (currently ${(sum / 100).toFixed(1)}%).`);
  if (normalized.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY).length === 0) errors.push("Add at least one stock.");
  return { ok: errors.length === 0, errors, normalized };
}

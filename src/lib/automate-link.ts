import type { Address } from "viem";
import { TOTAL_BPS, USDC_ALLOCATION_KEY, type Allocation } from "@/domain/portfolio";

/**
 * A basket handed from Build (or a template, or a community basket) to Automate travels in the
 * URL, so the link can be shared, bookmarked and opened later: `/automate?legs=<addr:bps,…>&name=…`.
 */
export function automateHref(allocations: Allocation[], name?: string): string {
  const legs = allocations
    .filter((a) => a.weightBps > 0)
    .map((a) => `${a.assetAddress === USDC_ALLOCATION_KEY ? "USDC" : a.assetAddress}:${a.weightBps}`)
    .join(",");
  const params = new URLSearchParams();
  if (legs) params.set("legs", legs);
  if (name?.trim()) params.set("name", name.trim().slice(0, 48));
  const q = params.toString();
  return q ? `/automate?${q}` : "/automate";
}

/** Parse the `legs` parameter back; anything malformed is dropped rather than guessed at. */
export function parseAutomateLegs(raw: string | null): Allocation[] {
  if (!raw) return [];
  const out: Allocation[] = [];
  for (const part of raw.split(",")) {
    const [addr, bps] = part.split(":");
    const weight = Number(bps);
    if (!addr || !Number.isInteger(weight) || weight <= 0 || weight > TOTAL_BPS) continue;
    if (addr === "USDC") out.push({ assetAddress: USDC_ALLOCATION_KEY, weightBps: weight });
    else if (/^0x[0-9a-fA-F]{40}$/.test(addr)) out.push({ assetAddress: addr as Address, weightBps: weight });
  }
  const sum = out.reduce((s, a) => s + a.weightBps, 0);
  return sum === TOTAL_BPS ? out : [];
}

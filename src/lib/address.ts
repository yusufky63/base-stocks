import { getAddress, isAddress, type Address } from "viem";

/** Normalize to EIP-55 checksum. Throws on invalid input. */
export function normalizeAddress(input: string): Address {
  const trimmed = input.trim();
  if (!isAddress(trimmed, { strict: false })) throw new Error(`Invalid address: ${trimmed}`);
  return getAddress(trimmed);
}

export function tryNormalizeAddress(input: string | null | undefined): Address | null {
  if (!input) return null;
  try {
    return normalizeAddress(input);
  } catch {
    return null;
  }
}

export function isSameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Basename syntax check (not a resolution). Accepts `name.base.eth` labels only. */
export function looksLikeBasename(input: string): boolean {
  const v = input.trim().toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.base\.eth$/.test(v);
}

export function isB20PrecompileAddress(address: string): boolean {
  return /^0xb20[0-9a-f]{37}$/i.test(address);
}

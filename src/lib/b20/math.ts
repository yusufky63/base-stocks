import { formatUnits, parseUnits } from "viem";

/** WAD precision used by B20 multipliers (verified WAD_PRECISION() == 1e18). */
export const WAD = 10n ** 18n;

/** scaled = raw × multiplier / WAD (mirrors `toScaledBalance`). */
export function toScaled(raw: bigint, multiplier: bigint, wad: bigint = WAD): bigint {
  if (wad === 0n) throw new Error("wad must be > 0");
  return (raw * multiplier) / wad;
}

/** raw = scaled × WAD / multiplier (mirrors `toRawBalance`). */
export function toRaw(scaled: bigint, multiplier: bigint, wad: bigint = WAD): bigint {
  if (multiplier === 0n) throw new Error("multiplier must be > 0");
  return (scaled * wad) / multiplier;
}

/** Multiplier as a JS number (display only). */
export function multiplierToNumber(multiplier: bigint, wad: bigint = WAD): number {
  return Number(formatUnits(multiplier, 18)) * (Number(WAD) / Number(wad));
}

/**
 * Token price (per raw token) → equity price per share-equivalent.
 * Chainlink stock feeds and DEX prices are per RAW token and already total-return
 * (multiplier-adjusted). Divide by the multiplier to get the per-share number.
 * Never multiply a token price by the multiplier again.
 */
export function equityPricePerShare(tokenPriceUsd: number, multiplier: bigint, wad: bigint = WAD): number {
  const m = multiplierToNumber(multiplier, wad);
  return m === 0 ? 0 : tokenPriceUsd / m;
}

/** USD value of a RAW balance priced per raw token. */
export function rawValueUsd(raw: bigint, decimals: number, tokenPriceUsd: number): number {
  return Number(formatUnits(raw, decimals)) * tokenPriceUsd;
}

/** Human amount → base units, tolerant of empty/invalid input (returns 0n). */
export function parseAmountSafe(value: string, decimals: number): bigint {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed || !/^\d*(\.\d*)?$/.test(trimmed)) return 0n;
  try {
    return parseUnits(trimmed === "." ? "0" : trimmed, decimals);
  } catch {
    return 0n;
  }
}

export function formatUnitsNumber(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

/** Percentage of a balance in basis points, floored to the base unit. */
export function bpsOf(value: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) throw new Error("bps out of range");
  return (value * BigInt(bps)) / 10_000n;
}

/** Split a USD total into per-leg USD amounts by weight; remainder goes to the largest leg. */
export function splitByWeights(totalUsdCents: bigint, weightsBps: number[]): bigint[] {
  const sum = weightsBps.reduce((a, b) => a + b, 0);
  if (sum === 0) return weightsBps.map(() => 0n);
  const parts = weightsBps.map((w) => (totalUsdCents * BigInt(w)) / BigInt(sum));
  const allocated = parts.reduce((a, b) => a + b, 0n);
  const remainder = totalUsdCents - allocated;
  if (remainder !== 0n && parts.length > 0) {
    let maxIdx = 0;
    weightsBps.forEach((w, i) => {
      if (w > weightsBps[maxIdx]!) maxIdx = i;
    });
    parts[maxIdx] = parts[maxIdx]! + remainder;
  }
  return parts;
}

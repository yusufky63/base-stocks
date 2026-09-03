import { CURATED_B20_ASSETS } from "@/lib/b20/registry";

/**
 * Deterministic per-asset colours for allocation bars and legends. Distinct hues that stay
 * legible on both themes; USDC/cash is always neutral grey. Colour is never the only signal
 * (labels and percentages accompany every swatch).
 */
const PALETTE = ["#0000ff", "#16a34a", "#f59e0b", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316", "#14b8a6", "#e11d48", "#84cc16", "#a855f7", "#06b6d4", "#eab308", "#64748b", "#db2777", "#22c55e"];

const byAddress = new Map(CURATED_B20_ASSETS.map((a, i) => [a.address.toLowerCase(), PALETTE[i % PALETTE.length]!]));
const byTicker = new Map(CURATED_B20_ASSETS.map((a, i) => [a.underlying.toUpperCase(), PALETTE[i % PALETTE.length]!]));

export const USDC_COLOR = "#9aa3b2";
/** Idle USDC that is deposited in a yield venue. */
export const EARN_COLOR = "#14b8a6";

function hashHue(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

/** Colour for an asset address, ticker or symbol ("NVDAc" → NVDA). "USDC" → grey. */
export function assetColor(key: string | undefined | null): string {
  if (!key) return USDC_COLOR;
  if (key === "USDC" || key.toUpperCase() === "USDC") return USDC_COLOR;
  if (key === "EARN") return EARN_COLOR;
  const lower = key.toLowerCase();
  if (byAddress.has(lower)) return byAddress.get(lower)!;
  const ticker = key.toUpperCase().replace(/C$/, "");
  if (byTicker.has(ticker)) return byTicker.get(ticker)!;
  return hashHue(lower);
}

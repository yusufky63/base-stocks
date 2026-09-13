import type { GiftParty, GiftReceipt, GiftRecord } from "@/domain/gift";
import { formatTokenAmount, shortenAddress } from "@/lib/format";

/**
 * Pure display helpers for gifts, shared by the server (receipt pages, OG cards) and the browser
 * (claim page, history, inbox). Nothing here touches a database or the chain, so a client bundle
 * can import it without dragging the gift service along.
 */

/** Share-equivalent amount from raw base units: raw × multiplier / WAD. */
export function scaledAmount(raw: bigint | string, multiplier: bigint | string, wadPrecision: bigint | string): bigint {
  const wad = BigInt(wadPrecision);
  if (wad === 0n) return BigInt(raw);
  return (BigInt(raw) * BigInt(multiplier)) / wad;
}

/** "0.5" — the share-equivalent of a raw amount, formatted with the asset's decimals. */
export function formatShares(raw: bigint | string, asset: { multiplier: bigint | string; wadPrecision: bigint | string; decimals: number }, maxFraction?: number): string {
  return formatTokenAmount(scaledAmount(raw, asset.multiplier, asset.wadPrecision), asset.decimals, maxFraction);
}

/** Share-equivalent amount of the gift ("0.5 NVDA"), applying the B20 multiplier. */
export function giftAmountLabel(r: Pick<GiftReceipt, "gift" | "asset">): string {
  if (!r.asset) return "stock";
  return `${formatShares(r.gift.rawAmount, r.asset)} ${r.asset.underlying}`;
}

/**
 * Words a display name may not carry. A profile can call itself anything, and a claim link that
 * says it comes from "Coinbase Support" is exactly how someone gets talked into clicking. "base"
 * is matched as a whole word so "database" and "Basel" survive; the others are matched anywhere,
 * with spaces and punctuation removed, so "Coin base" and "Coinbase_Support" do not.
 */
const BRAND_ANYWHERE = /coinbase|basestocks|bstocks|support|official|admin/;

export function isBrandLikeName(name: string | null | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (BRAND_ANYWHERE.test(lower.replace(/[^a-z0-9]/g, ""))) return true;
  return lower.split(/[^a-z0-9]+/).some((w) => w === "base");
}

/** The identity of a party: a Basename, else the short address. Never a self-chosen display name. */
export function giftPartyLabel(p: Pick<GiftParty, "address" | "basename">): string {
  return p.basename ?? shortenAddress(p.address);
}

/**
 * What to call a party in a sentence. A display name is shown, but never alone: the Basename or
 * the address always stands beside it, so a name cannot pretend to be someone it is not.
 */
export function giftPartyName(p: Pick<GiftParty, "address" | "basename" | "displayName">): string {
  const identity = giftPartyLabel(p);
  const name = p.displayName && !isBrandLikeName(p.displayName) ? p.displayName.trim() : null;
  return name && name.toLowerCase() !== identity.toLowerCase() ? `${name} · ${identity}` : identity;
}

export type GiftStatusKey = "claimed" | "reclaimed" | "failed" | "expired" | "awaiting" | "delivered" | "submitted";

export interface GiftStatusInfo {
  key: GiftStatusKey;
  label: string;
  tone: "positive" | "warning" | "danger" | "neutral" | "primary";
}

/**
 * One reading of a gift's state for every list and badge. Order matters: a failed or expired
 * claim link is not "awaiting claim", whatever its kind says.
 */
export function giftStatusInfo(g: Pick<GiftRecord, "status" | "kind" | "expiresAt">, now: number = Date.now()): GiftStatusInfo {
  if (g.status === "claimed") return { key: "claimed", label: "Claimed", tone: "positive" };
  if (g.status === "reclaimed") return { key: "reclaimed", label: "Cancelled by sender", tone: "neutral" };
  if (g.status === "failed") return { key: "failed", label: "Failed", tone: "danger" };
  if (g.kind === "claim-link") {
    if (g.expiresAt !== undefined && now > g.expiresAt) return { key: "expired", label: "Expired", tone: "neutral" };
    return { key: "awaiting", label: "Awaiting claim", tone: "primary" };
  }
  if (g.status === "confirmed") return { key: "delivered", label: "Delivered", tone: "positive" };
  return { key: "submitted", label: "Submitted", tone: "warning" };
}

/** First `max` characters of a message, counted in code points so an emoji is never cut in half. */
export function truncateMessage(message: string, max = 40): string {
  const chars = Array.from(message);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : message;
}

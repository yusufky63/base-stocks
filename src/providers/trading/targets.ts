import type { Address } from "viem";
import type { TradeProviderId } from "@/domain/trade";
import { EXPECTED_TARGETS as ZEROX } from "./zero-x/adapter";
import { EXPECTED_TARGETS as KYBER } from "./kyber/adapter";
import { EXPECTED_TARGETS as OKX } from "./okx/adapter";
import { EXPECTED_TARGETS as UNISWAP } from "./uniswap/adapter";
import { EXPECTED_TARGETS as VELORA } from "./velora/adapter";
import { EXPECTED_TARGETS as AERODROME } from "./aerodrome/adapter";
import { EXPECTED_TARGETS as COW } from "./cow/adapter";

/**
 * The contracts each route is allowed to send the wallet to, or ask it to approve.
 *
 * Every quote's `transaction.to` and spender came straight out of a provider response and went
 * straight into the wallet. A compromised or spoofed response could therefore have the user
 * approve an arbitrary contract and call it with their tokens in reach. Each adapter now names its
 * own contracts, verified against the provider's documentation or the chain (the constants say
 * where), and the router refuses a quote naming anything else. The list is data, not behaviour: a
 * provider that genuinely moves to a new contract fails closed until the new address is checked
 * and added.
 */
const KNOWN: Record<TradeProviderId, ReadonlySet<string>> = {
  zeroX: lower(ZEROX),
  kyber: lower(KYBER),
  okx: lower(OKX),
  uniswap: lower(UNISWAP),
  velora: lower(VELORA),
  aerodrome: lower(AERODROME),
  cow: lower(COW),
};

function lower(addresses: readonly Address[]): ReadonlySet<string> {
  return new Set(addresses.map((a) => a.toLowerCase()));
}

/** Whether `address` is one of the contracts `provider` is known to use. */
export function isKnownTarget(provider: TradeProviderId, address: Address | null | undefined): boolean {
  if (!address) return false;
  return KNOWN[provider]?.has(address.toLowerCase()) ?? false;
}

/** The allowlist for one provider, for diagnostics. */
export function knownTargets(provider: TradeProviderId): readonly string[] {
  return [...(KNOWN[provider] ?? [])];
}

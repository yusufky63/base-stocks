import type { EarnProviderId } from "@/domain/earn";

/**
 * What each Earn venue is called, once. Five components used to carry their own copy of this
 * map, and they had already started to disagree ("Aave" here, "Aave V3" there).
 */
export const EARN_PROVIDER_LABEL: Record<EarnProviderId, string> = { morpho: "Morpho", aave: "Aave", compound: "Compound", aerodrome: "Aerodrome", uniswap: "Uniswap" };

/** The venue's full product name, for places that list it next to trade routes and other products. */
export const EARN_VENUE_LABEL: Record<EarnProviderId, string> = { morpho: "Morpho", aave: "Aave V3", compound: "Compound v3", aerodrome: "Aerodrome Slipstream", uniswap: "Uniswap v3" };

export function earnProviderLabel(provider: string): string {
  return (EARN_PROVIDER_LABEL as Record<string, string>)[provider] ?? provider;
}

export function earnVenueLabel(provider: string): string {
  return (EARN_VENUE_LABEL as Record<string, string>)[provider] ?? provider;
}

import type { Address } from "viem";
import type { CuratedAssetEntry } from "@/domain/asset";

/**
 * Curated canonical list of Coinbase Tokenized Stocks on Base.
 * Source: https://docs.base.org/specifications/b20/tokenized-stocks-on-base (verified 2026-09-02).
 *
 * Identity is the contract address. Names/symbols are read onchain at runtime because
 * B20 metadata is mutable. This list is a bootstrap: new stocks are discovered from the
 * factory's `B20Created` events, matched to their Chainlink "Coinbase <TICKER>" feed and the
 * Coinbase oracle registry, and added to the live registry (see b20-asset-service
 * `syncDiscoveredAssets`) — no deploy needed when Coinbase lists a 14th stock.
 */
export const CURATED_B20_ASSETS: readonly CuratedAssetEntry[] = [
  { address: "0xb200000000000000000000C2e324d24d7eEcd1fb", underlying: "AAPL", chainlinkFeed: "0x787f13dEa48Db0897CbCDD985de77809D837F988", tags: ["technology"] },
  { address: "0xb200000000000000000000d9192b6B456483C2E8", underlying: "AMZN", chainlinkFeed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295", tags: ["technology", "ai"] },
  { address: "0xb200000000000000000000c85a31389D71F3ecfb", underlying: "COIN", chainlinkFeed: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7", tags: ["finance", "crypto"] },
  { address: "0xB20000000000000000000019f6E7C675b73C2e4D", underlying: "CRCL", chainlinkFeed: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33", tags: ["finance", "crypto"] },
  { address: "0xb2000000000000000000002D0BA3164cc74f58B7", underlying: "GOOGL", chainlinkFeed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2", tags: ["technology", "ai"] },
  { address: "0xB2000000000000000000004AFF16039bA04bdFBc", underlying: "INTC", chainlinkFeed: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB", tags: ["technology", "semiconductors"] },
  { address: "0xb2000000000000000000008bC8786B856E61707C", underlying: "META", chainlinkFeed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D", tags: ["technology", "ai"] },
  { address: "0xB200000000000000000000Ab99cFa739E253872B", underlying: "MSFT", chainlinkFeed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c", tags: ["technology", "ai"] },
  { address: "0xb2000000000000000000004884b426556b92883d", underlying: "MSTR", chainlinkFeed: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a", tags: ["technology", "crypto"] },
  { address: "0xb20000000000000000000078ee7ce2fE4908108C", underlying: "NVDA", chainlinkFeed: "0x04689a41629776563E6822F76f2e57D148d28513", tags: ["technology", "ai", "semiconductors"] },
  { address: "0xb200000000000000000000397293Cb8cda9a10c5", underlying: "SNDK", chainlinkFeed: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA", tags: ["technology", "semiconductors"] },
  { address: "0xb2000000000000000000007b9fcbd005511aCBd5", underlying: "SPCX", chainlinkFeed: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68", tags: ["technology"] },
  { address: "0xb2000000000000000000001e800a7f5189430cD0", underlying: "TSLA", chainlinkFeed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4", tags: ["technology", "ai"] },
];

const curatedById = new Map<string, CuratedAssetEntry>(CURATED_B20_ASSETS.map((e) => [e.address.toLowerCase(), e]));

/** Discovered + verified stocks, loaded from storage at boot and refreshed by discovery. Process-global so every bundle sees the same list. */
const g = globalThis as unknown as { __bstocksRegistryExtra?: Map<string, CuratedAssetEntry> };
const extraById: Map<string, CuratedAssetEntry> = (g.__bstocksRegistryExtra ??= new Map());

export function canonicalId(address: string): string {
  return address.toLowerCase();
}

/** Replace the discovered set (verified rows only). Curated entries always win on conflict. */
export function setDiscoveredEntries(entries: CuratedAssetEntry[]): void {
  extraById.clear();
  for (const e of entries) {
    const id = canonicalId(e.address);
    if (!curatedById.has(id)) extraById.set(id, e);
  }
}

export function discoveredEntries(): CuratedAssetEntry[] {
  return [...extraById.values()];
}

/** Curated first, then discovered stocks — the list every screen and service works from. */
export function allAssetEntries(): CuratedAssetEntry[] {
  return [...CURATED_B20_ASSETS, ...extraById.values()];
}

export function findCuratedAsset(address: string): CuratedAssetEntry | undefined {
  const id = canonicalId(address);
  return curatedById.get(id) ?? extraById.get(id);
}

export function isCuratedAsset(address: string): boolean {
  return findCuratedAsset(address) !== undefined;
}

export function curatedAddresses(): Address[] {
  return allAssetEntries().map((e) => e.address);
}

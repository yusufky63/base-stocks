import { erc20Abi, type Address } from "viem";
import type { EarnExecution, EarnIntent, EarnOpportunity, EarnPosition } from "@/domain/earn";
import { cached, TTL } from "@/lib/cache";
import { morphoProvider } from "@/providers/earn/morpho/adapter";
import { aaveProvider, AAVE_V3_BASE_DATA_PROVIDER } from "@/providers/earn/aave/adapter";
import { aerodromeProvider } from "@/providers/earn/aerodrome/adapter";
import { compoundProvider, COMET_USDC_BASE, cometAbi } from "@/providers/earn/compound/adapter";
import { uniswapProvider } from "@/providers/earn/uniswap/adapter";
import { discoverDexPoolOpportunities } from "@/providers/earn/geckoterminal-pools";
import { getAsset } from "./b20-asset-service";
import { USDC_ADDRESS, USDC_DECIMALS } from "@/config/chain";
import { AppError } from "@/lib/errors";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { aaveDataProviderAbi, erc4626Abi } from "@/lib/earn/abis";

/**
 * Earn is opportunistic, not assumed (spec §4.7). Every provider is queried at runtime
 * with a bounded timeout; failures hide that provider's opportunities. Discovery never
 * blocks the stock page render — it is fetched separately by the client.
 */
export interface EarnDiscoveryResult {
  assetAddress: Address;
  opportunities: EarnOpportunity[];
  /** Providers that errored or timed out (hidden from consumer UI, visible in details). */
  unavailableProviders: string[];
  updatedAt: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch(() => {
      clearTimeout(t);
      resolve(fallback);
    });
  });
}

async function discoverFor(address: Address, priceUsd: number | null, user?: Address): Promise<EarnDiscoveryResult> {
  const sentinel: EarnOpportunity[] | null = null;
  const [morpho, aave, aero, compound, uniswap] = await Promise.all([
    withTimeout(morphoProvider.discover(address), 7_000, sentinel),
    withTimeout(aaveProvider.discover(address), 7_000, sentinel),
    withTimeout(aerodromeProvider.discover(address, user, priceUsd), 7_000, sentinel),
    withTimeout(compoundProvider.discover(address), 7_000, sentinel),
    withTimeout(uniswapProvider.discover(address, user, priceUsd), 7_000, sentinel),
  ]);
  const unavailable: string[] = [];
  if (morpho === null) unavailable.push("morpho");
  if (aave === null) unavailable.push("aave");
  if (aero === null) unavailable.push("aerodrome");
  if (compound === null) unavailable.push("compound");
  if (uniswap === null) unavailable.push("uniswap");
  // Pools the factory scans cannot see (Uniswap v4 singleton), via GeckoTerminal; never duplicates a known pool.
  const known = new Set([...(aero ?? []), ...(uniswap ?? [])].map((o) => String(o.metadata.pool ?? "").toLowerCase()));
  const extraPools = (await withTimeout(discoverDexPoolOpportunities(address, known), 6_000, sentinel)) ?? [];
  const opportunities = [...(morpho ?? []), ...(aave ?? []), ...(compound ?? []), ...(aero ?? []), ...(uniswap ?? []), ...extraPools].sort((a, b) => (b.tvlUsd ?? b.liquidityUsd ?? 0) - (a.tvlUsd ?? a.liquidityUsd ?? 0));
  return { assetAddress: address, opportunities, unavailableProviders: unavailable, updatedAt: Date.now() };
}

export async function discoverEarn(assetAddress: Address, user?: Address): Promise<EarnDiscoveryResult> {
  return cached(`earn:${assetAddress.toLowerCase()}`, TTL.earn, async () => {
    const asset = await getAsset(assetAddress);
    if (!asset) return { assetAddress, opportunities: [], unavailableProviders: [], updatedAt: Date.now() };
    return discoverFor(asset.address, asset.oracle?.priceUsd ?? null, user);
  });
}

/**
 * An APY that only an upstream API could have produced.
 *
 * Morpho's vault feed occasionally reports a rate in the tens of thousands of percent for a small
 * vault — a real number in the data, and obvious nonsense on a page about where to put savings.
 * Aave and Compound are read from their own contracts and cannot drift this way, but the same
 * ceiling is applied to everything so one rule covers the list.
 */
const MAX_PLAUSIBLE_APY = 50;

/** Vaults thinner than this are curator experiments, not somewhere to point a stranger's USDC. */
const MIN_VAULT_TVL_USD = 100_000;

/** How many vaults are taken for depth, and how many for rate. The union is what gets shown. */
const VAULTS_BY_TVL = 4;
const VAULTS_BY_APY = 4;

function plausible(o: EarnOpportunity): boolean {
  const apy = o.variableApy;
  if (apy === undefined || !Number.isFinite(apy) || apy < 0 || apy > MAX_PLAUSIBLE_APY) return false;
  // Aave and Compound report no TVL of their own here; the floor is a vault rule.
  return o.type !== "vault" || (o.tvlUsd ?? 0) >= MIN_VAULT_TVL_USD;
}

/**
 * "Put idle USDC to work": the lending markets, plus the Morpho vaults worth showing.
 *
 * Selection takes the union of the largest vaults and the best-paying ones. Either alone lies:
 * ranking by TVL buried a vault paying a point more than anything on the page, and ranking by APY
 * alone would drop the two deepest vaults on Base for a small one with a better week. The list is
 * then ordered by rate, because that is what the reader is scanning for; depth, fee, curator
 * vetting and data age all sit on the row for the decision that follows.
 *
 * Borrow markets and liquidity pools are left out — this module is about idle USDC earning a
 * variable rate, and both of those are a different bargain. `inApp` is deliberately not a filter:
 * a venue that has to be finished in its own interface is still worth knowing about, and the row
 * links out instead of offering a deposit button.
 */
export function curateUsdcVenues(all: EarnOpportunity[]): EarnOpportunity[] {
  const usable = all.filter((o) => (o.type === "supply" || o.type === "vault") && plausible(o));
  const markets = usable.filter((o) => o.type === "supply");
  const vaults = usable.filter((o) => o.type === "vault");
  const byTvl = [...vaults].sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0)).slice(0, VAULTS_BY_TVL);
  const byApy = [...vaults].sort((a, b) => (b.variableApy ?? 0) - (a.variableApy ?? 0)).slice(0, VAULTS_BY_APY);
  const picked = new Map([...byTvl, ...byApy].map((o) => [o.id, o]));
  return [...markets, ...picked.values()].sort((a, b) => (b.variableApy ?? 0) - (a.variableApy ?? 0));
}

export async function discoverUsdcEarn(): Promise<EarnDiscoveryResult> {
  const r = await usdcDiscovery();
  return { ...r, opportunities: curateUsdcVenues(r.opportunities) };
}

/**
 * The raw USDC discovery, cached once and shared by the display list and the position reader.
 *
 * The two need different lists. Display is curated down to what is worth offering; positions have
 * to cover every venue a deposit could already be sitting in, including one that has since fallen
 * out of the shortlist. Reading positions from the curated list is how somebody's balance quietly
 * disappears from the page while their money is still in the vault.
 */
function usdcDiscovery(): Promise<EarnDiscoveryResult> {
  // A key of its own: "earn:usdc" used to hold the curated list, and re-curating that after a
  // deploy would quietly serve a list of a list until the old entry aged out.
  return cached("earn:usdc:raw", TTL.earn, () => discoverFor(USDC_ADDRESS, 1, undefined));
}

/** Build deposit / withdraw calls for an opportunity id. The client executes them with the wallet. */
export async function prepareEarn(input: EarnIntent): Promise<EarnExecution> {
  if (input.opportunityId.startsWith("morpho:")) return morphoProvider.prepare(input);
  if (input.opportunityId.startsWith("aave:")) return aaveProvider.prepare(input);
  if (input.opportunityId.startsWith("compound:")) return compoundProvider.prepare(input);
  throw new AppError("PROVIDER_UNAVAILABLE", "This opportunity is completed in the venue's own interface.", 501);
}

/** Current positions in the USDC opportunities (vault shares → assets, aToken balance). */
export async function getEarnPositions(user: Address): Promise<EarnPosition[]> {
  const { opportunities } = await usdcDiscovery();
  const client = getServerPublicClient();
  const positions: EarnPosition[] = [];
  const vaults = opportunities.filter((o) => o.provider === "morpho" && o.type === "vault").map((o) => ({ o, vault: String(o.metadata.vault) as Address }));
  const aave = opportunities.find((o) => o.provider === "aave");
  const contracts = vaults.map((v) => ({ address: v.vault, abi: erc4626Abi, functionName: "balanceOf" as const, args: [user] as const }));
  const shares = contracts.length ? await client.multicall({ contracts, allowFailure: true }) : [];
  const assetCalls = vaults.map((v, i) => ({ address: v.vault, abi: erc4626Abi, functionName: "convertToAssets" as const, args: [shares[i]?.status === "success" ? (shares[i]!.result as bigint) : 0n] as const }));
  const assets = assetCalls.length ? await client.multicall({ contracts: assetCalls, allowFailure: true }) : [];
  vaults.forEach((v, i) => {
    const a = assets[i]?.status === "success" ? (assets[i]!.result as bigint) : 0n;
    if (a > 0n) positions.push({ opportunityId: v.o.id, provider: "morpho", title: v.o.title, underlying: USDC_ADDRESS, underlyingSymbol: "USDC", underlyingDecimals: USDC_DECIMALS, assets: a, valueUsd: Number(a) / 10 ** USDC_DECIMALS, variableApy: v.o.variableApy });
  });
  if (aave) {
    try {
      const [aToken] = await client.readContract({ address: AAVE_V3_BASE_DATA_PROVIDER, abi: aaveDataProviderAbi, functionName: "getReserveTokensAddresses", args: [USDC_ADDRESS] });
      const bal = await client.readContract({ address: aToken, abi: erc20Abi, functionName: "balanceOf", args: [user] });
      if (bal > 0n) positions.push({ opportunityId: aave.id, provider: "aave", title: aave.title, underlying: USDC_ADDRESS, underlyingSymbol: "USDC", underlyingDecimals: USDC_DECIMALS, assets: bal, valueUsd: Number(bal) / 10 ** USDC_DECIMALS, variableApy: aave.variableApy });
    } catch {
      /* reserve unavailable */
    }
  }
  const compound = opportunities.find((o) => o.provider === "compound");
  if (compound) {
    try {
      const bal = await client.readContract({ address: COMET_USDC_BASE, abi: cometAbi, functionName: "balanceOf", args: [user] });
      if (bal > 0n) positions.push({ opportunityId: compound.id, provider: "compound", title: compound.title, underlying: USDC_ADDRESS, underlyingSymbol: "USDC", underlyingDecimals: USDC_DECIMALS, assets: bal, valueUsd: Number(bal) / 10 ** USDC_DECIMALS, variableApy: compound.variableApy });
    } catch {
      /* market unavailable */
    }
  }
  return positions;
}

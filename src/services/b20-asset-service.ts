import { getAddress, isAddress, type Address } from "viem";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { b20AssetAbi, b20FactoryAbi, B20_PAUSABLE_FEATURE, B20_POLICY_SCOPE, stockOracleRegistryAbi } from "@/lib/b20/abi";
import { CURATED_B20_ASSETS, allAssetEntries, canonicalId, discoveredEntries, findCuratedAsset, setDiscoveredEntries } from "@/lib/b20/registry";
import { findCoinbaseFeed } from "@/providers/market-data/chainlink/directory";
import { getCoinbaseNavReadings, getCoinbaseStockListings, type CoinbaseNavReading } from "@/providers/coinbase/tokenized-stocks";
import { getRepos, type DiscoveredAsset } from "@/db/repositories";
import { WAD } from "@/lib/b20/math";
import { B20_FACTORY_ADDRESS, COINBASE_B20_CREATORS, STOCK_ORACLE_REGISTRY_ADDRESS, USDC_ADDRESS } from "@/config/chain";
import { serverEnv } from "@/config/env";
import type { AssetBalance, B20Asset, CuratedAssetEntry, OracleState, PendingMultiplier } from "@/domain/asset";
import { cached, TTL, invalidate } from "@/lib/cache";
import { readFeeds, type FeedReading } from "@/providers/market-data/chainlink/reader";
import { recallGood, rememberGood } from "@/lib/last-good";
import { classifyFreshness, isUsMarketOpen, secondsSinceUsMarketClose, secondsSinceUsMarketOpen } from "@/lib/market-hours";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { getMarketDataProvider } from "@/providers/market-data";
import { filterWithConcurrency, hasTwoWayStockRoute, marketListingBlockedReason } from "./asset-tradability-service";

interface StaticMeta {
  name: string;
  symbol: string;
  decimals: number;
  wadPrecision: bigint;
  contractURI?: string;
  logoURI?: string;
  transferSenderPolicyId: bigint;
  transferReceiverPolicyId: bigint;
  isin?: string;
}

interface LiveState {
  multiplier: bigint;
  transferPaused: boolean;
  oracleRegistryPaused: boolean | null;
  oracleRegistryMultiplier: bigint | null;
  /** Null when the node did not answer and nothing earlier is known. */
  totalSupply: bigint | null;
  pendingMultiplier?: PendingMultiplier;
}

function parseContractUriLogo(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    if (uri.startsWith("data:application/json;base64,")) {
      const json = JSON.parse(Buffer.from(uri.slice("data:application/json;base64,".length), "base64").toString("utf8")) as { image?: string };
      return typeof json.image === "string" ? json.image : undefined;
    }
    if (uri.startsWith("data:application/json,")) {
      const json = JSON.parse(decodeURIComponent(uri.slice("data:application/json,".length))) as { image?: string };
      return typeof json.image === "string" ? json.image : undefined;
    }
  } catch {
    /* ignore malformed metadata */
  }
  return undefined;
}

/** Static-ish metadata: long cache, invalidated by admin refresh or metadata events. */
async function loadStaticMeta(entries: readonly CuratedAssetEntry[]): Promise<Map<string, StaticMeta>> {
  const client = getServerPublicClient();
  const contracts = entries.flatMap((e) => [
    { address: e.address, abi: b20AssetAbi, functionName: "name" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "symbol" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "decimals" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "WAD_PRECISION" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "contractURI" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "policyId", args: [B20_POLICY_SCOPE.TRANSFER_SENDER] } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "policyId", args: [B20_POLICY_SCOPE.TRANSFER_RECEIVER] } as const,
    // Issuer metadata (spec "Extra metadata"): the ISIN is stored under the lowercase key on mainnet.
    { address: e.address, abi: b20AssetAbi, functionName: "extraMetadata", args: ["isin"] } as const,
  ]);
  const res = await client.multicall({ contracts, allowFailure: true });
  const out = new Map<string, StaticMeta>();
  const PER = 8;
  entries.forEach((e, i) => {
    const r = res.slice(i * PER, i * PER + PER);
    const ok = (idx: number) => r[idx]?.status === "success";
    if (!ok(0) || !ok(1) || !ok(2)) {
      metrics.count("b20.meta", false, `metadata read failed for ${e.address}`);
      return;
    }
    const contractURI = ok(4) ? (r[4]!.result as string) : undefined;
    out.set(canonicalId(e.address), {
      name: r[0]!.result as string,
      symbol: r[1]!.result as string,
      decimals: Number(r[2]!.result),
      wadPrecision: ok(3) ? (r[3]!.result as bigint) : WAD,
      contractURI,
      logoURI: parseContractUriLogo(contractURI),
      transferSenderPolicyId: ok(5) ? (r[5]!.result as bigint) : 0n,
      transferReceiverPolicyId: ok(6) ? (r[6]!.result as bigint) : 0n,
      isin: ok(7) && typeof r[7]!.result === "string" && (r[7]!.result as string).length > 0 ? (r[7]!.result as string) : undefined,
    });
  });
  metrics.count("b20.meta", true);
  return out;
}

/**
 * Live state: multiplier, pause flags, oracle registry, supply. Short cache, and never a guess:
 * a call the node failed to answer takes the last value it did answer with, and a batch the node
 * refused altogether is served from the last batch it accepted. A supply that was never read is
 * null — "unknown" — and the pages treat it as such rather than as zero.
 */
const LIVE_KEY = "b20:live";
const FEEDS_KEY = "b20:feeds";

async function loadLiveState(entries: readonly CuratedAssetEntry[]): Promise<Map<string, LiveState>> {
  const good = await recallGood<Map<string, LiveState>>(LIVE_KEY);
  let out: Map<string, LiveState>;
  try {
    out = await readLiveState(entries, good?.value ?? null);
  } catch (err) {
    if (good) {
      metrics.count("b20.live.lastgood", true);
      return good.value;
    }
    throw err;
  }
  // Remember only a batch that actually answered; an all-failed batch teaches nothing.
  if ([...out.values()].some((l) => l.totalSupply !== null)) rememberGood(LIVE_KEY, out);
  return out;
}

/** Chainlink feed readings, with the last good reading standing in for any feed that did not answer. */
async function loadFeeds(feeds: Address[]): Promise<Awaited<ReturnType<typeof readFeeds>>> {
  const good = await recallGood<Awaited<ReturnType<typeof readFeeds>>>(FEEDS_KEY);
  let fresh: Awaited<ReturnType<typeof readFeeds>>;
  try {
    fresh = await readFeeds(feeds);
  } catch (err) {
    if (good) {
      metrics.count("b20.feeds.lastgood", true);
      return good.value;
    }
    throw err;
  }
  const merged = new Map(fresh);
  for (const f of feeds) {
    const k = f.toLowerCase();
    if (!merged.get(k) && good?.value.get(k)) merged.set(k, good.value.get(k)!);
  }
  if ([...fresh.values()].some(Boolean)) rememberGood(FEEDS_KEY, merged);
  return merged;
}

/**
 * A feed the node did not answer for, with no earlier reading to stand in, takes the reading
 * Coinbase's API publishes for the same token. It is the same Chainlink round copied off-chain
 * (`nav_price` and its `updatedAt`), so it is a second path to the number, not a second source of
 * it, and the freshness rules apply to it unchanged. Asked only when something is missing.
 */
async function fillFeedsFromCoinbase(entries: readonly CuratedAssetEntry[], read: Map<string, FeedReading | null>): Promise<Map<string, FeedReading | null>> {
  const missing = entries.filter((e) => e.chainlinkFeed && !read.get(e.chainlinkFeed.toLowerCase()));
  if (missing.length === 0) return read;
  // A copy: `read` is the cached object, and a borrowed reading must not outlive this request in it.
  const feeds = new Map(read);
  const nav = await getCoinbaseNavReadings().catch(() => new Map<string, CoinbaseNavReading>());
  let filled = 0;
  for (const e of missing) {
    const r = nav.get(canonicalId(e.address));
    if (!r) continue;
    feeds.set(e.chainlinkFeed!.toLowerCase(), { feed: e.chainlinkFeed!, answer: BigInt(Math.round(r.priceUsd * 1e8)), updatedAt: BigInt(r.updatedAt), decimals: 8 });
    filled += 1;
  }
  if (filled > 0) metrics.count("b20.feeds.coinbase", true, `${filled} reading(s) from the Coinbase API`);
  return feeds;
}

async function readLiveState(entries: readonly CuratedAssetEntry[], good: Map<string, LiveState> | null): Promise<Map<string, LiveState>> {
  const client = getServerPublicClient();
  const contracts = entries.flatMap((e) => [
    { address: e.address, abi: b20AssetAbi, functionName: "multiplier" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "isPaused", args: [B20_PAUSABLE_FEATURE.TRANSFER] } as const,
    { address: STOCK_ORACLE_REGISTRY_ADDRESS, abi: stockOracleRegistryAbi, functionName: "getOracleParams", args: [e.address] } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "totalSupply" } as const,
    // ERC-8056 scheduled multiplier: the getters revert on tokens that predate the feature (allowFailure handles it).
    { address: e.address, abi: b20AssetAbi, functionName: "newUIMultiplier" } as const,
    { address: e.address, abi: b20AssetAbi, functionName: "effectiveAt" } as const,
  ]);
  const res = await client.multicall({ contracts, allowFailure: true });
  const out = new Map<string, LiveState>();
  const PER = 6;
  entries.forEach((e, i) => {
    const m = res[i * PER];
    const p = res[i * PER + 1];
    const o = res[i * PER + 2];
    const s = res[i * PER + 3];
    const nm = res[i * PER + 4];
    const ea = res[i * PER + 5];
    const oracle = o?.status === "success" ? (o.result as readonly [bigint, boolean]) : null;
    const pendingMultiplier = nm?.status === "success" && ea?.status === "success" && (nm.result as bigint) > 0n && (ea.result as bigint) > 0n ? { multiplier: nm.result as bigint, effectiveAt: ea.result as bigint } : undefined;
    const id = canonicalId(e.address);
    const prev = good?.get(id) ?? null;
    out.set(id, {
      multiplier: m?.status === "success" ? (m.result as bigint) : (prev?.multiplier ?? WAD),
      transferPaused: p?.status === "success" ? (p.result as boolean) : (prev?.transferPaused ?? false),
      oracleRegistryPaused: oracle ? oracle[1] : (prev?.oracleRegistryPaused ?? null),
      oracleRegistryMultiplier: oracle ? oracle[0] : (prev?.oracleRegistryMultiplier ?? null),
      totalSupply: s?.status === "success" ? (s.result as bigint) : (prev?.totalSupply ?? null),
      pendingMultiplier,
    });
  });
  return out;
}

function buildOracleState(entry: CuratedAssetEntry, live: LiveState, feed: { answer: bigint; updatedAt: bigint; decimals: number } | null): OracleState | undefined {
  if (!feed || !entry.chainlinkFeed || feed.answer <= 0n || feed.updatedAt <= 0n || feed.updatedAt > BigInt(Math.floor(Date.now() / 1000))) return undefined;
  const threshold = serverEnv().ORACLE_STALENESS_SECONDS;
  const paused = live.oracleRegistryPaused ?? false;
  const now = new Date();
  const marketOpen = isUsMarketOpen(now);
  const ageSeconds = Math.floor(now.getTime() / 1000) - Number(feed.updatedAt);
  // Off-hours a feed holds the close, however long ago it last wrote; "stale" means the value
  // itself can no longer be trusted, which is what the deviation gate and the API's `isStale` mean.
  const freshness = classifyFreshness({ ageSeconds, thresholdSeconds: threshold, paused, marketOpen, sinceCloseSeconds: secondsSinceUsMarketClose(now), sinceOpenSeconds: secondsSinceUsMarketOpen(now) });
  return {
    feed: entry.chainlinkFeed,
    answer: feed.answer,
    updatedAt: feed.updatedAt,
    decimals: feed.decimals,
    paused,
    stale: freshness === "stale",
    staleAfterSeconds: threshold,
    freshness,
    marketOpen,
    priceUsd: Number(feed.answer) / 10 ** feed.decimals,
  };
}

function deriveStatus(transferPaused: boolean, metaOk: boolean): B20Asset["status"] {
  if (!metaOk) return "unknown";
  if (transferPaused) return "paused";
  return "active";
}

async function assembleAssets(entries: readonly CuratedAssetEntry[]): Promise<B20Asset[]> {
  const feedAddresses = entries.map((e) => e.chainlinkFeed).filter((f): f is Address => !!f);
  const [meta, live, readFeedsResult] = await Promise.all([
    cached(`b20:meta:${entries.map((e) => e.address).join(",")}`, TTL.assetMetadata, () => loadStaticMeta(entries)),
    cached(`b20:live:${entries.map((e) => e.address).join(",")}`, TTL.oracleLive, () => loadLiveState(entries)),
    cached(`b20:feeds:${feedAddresses.join(",")}`, TTL.oracleFeed, () => loadFeeds(feedAddresses)).catch(() => new Map()),
  ]);
  const feeds = await fillFeedsFromCoinbase(entries, readFeedsResult);
  const now = Date.now();
  const assets: B20Asset[] = [];
  for (const e of entries) {
    const id = canonicalId(e.address);
    const m = meta.get(id);
    const l: LiveState = live.get(id) ?? { multiplier: WAD, transferPaused: false, oracleRegistryPaused: null, oracleRegistryMultiplier: null, totalSupply: null, pendingMultiplier: undefined };
    const f = e.chainlinkFeed ? feeds.get(e.chainlinkFeed.toLowerCase()) ?? null : null;
    assets.push({
      address: e.address,
      canonicalId: id,
      name: m?.name ?? e.underlying,
      symbol: m?.symbol ?? `${e.underlying}c`,
      underlying: e.underlying,
      decimals: m?.decimals ?? 8,
      contractURI: m?.contractURI,
      logoURI: m?.logoURI,
      tags: e.tags,
      multiplier: l.multiplier,
      wadPrecision: m?.wadPrecision ?? WAD,
      pendingMultiplier: l.pendingMultiplier,
      isin: m?.isin,
      totalSupply: l.totalSupply ?? 0n,
      supplyKnown: l.totalSupply !== null,
      transferSenderPolicyId: m?.transferSenderPolicyId ?? 0n,
      transferReceiverPolicyId: m?.transferReceiverPolicyId ?? 0n,
      transferPaused: l.transferPaused,
      oracle: buildOracleState(e, l, f),
      status: deriveStatus(l.transferPaused, !!m),
      verification: "verified",
      readAt: now,
    });
  }
  return assets;
}

/** All verified assets (curated bootstrap + discovered stocks) with live state. */
export async function getAssets(): Promise<B20Asset[]> {
  await refreshDiscoveredRegistry();
  return assembleAssets(allAssetEntries());
}

/** Single asset by canonical address. Returns null when not canonical. */
export async function getAsset(address: string): Promise<B20Asset | null> {
  await refreshDiscoveredRegistry();
  const entry = findCuratedAsset(address);
  if (!entry) return null;
  const [asset] = await assembleAssets([entry]);
  return asset ?? null;
}

/** Throws a typed error when the address is not a verified canonical asset. */
export async function requireAsset(address: string): Promise<B20Asset> {
  const asset = await getAsset(address);
  if (!asset) throw new AppError("ASSET_NOT_CANONICAL", "This asset is not a verified Coinbase Tokenized Stock.", 404);
  if (asset.verification !== "verified") throw new AppError("ASSET_NOT_VERIFIED", "This asset has not been verified for trading yet.", 403);
  return asset;
}

/** Raw + scaled balances for many assets in one multicall. */
export async function getBalances(owner: Address, assets: B20Asset[]): Promise<AssetBalance[]> {
  if (assets.length === 0) return [];
  const client = getServerPublicClient();
  const contracts = assets.flatMap((a) => [
    { address: a.address, abi: b20AssetAbi, functionName: "balanceOf", args: [owner] } as const,
    { address: a.address, abi: b20AssetAbi, functionName: "scaledBalanceOf", args: [owner] } as const,
  ]);
  const res = await client.multicall({ contracts, allowFailure: true });
  return assets.map((a, i) => {
    const raw = res[i * 2];
    const scaled = res[i * 2 + 1];
    const rawBalance = raw?.status === "success" ? (raw.result as bigint) : 0n;
    const scaledBalance = scaled?.status === "success" ? (scaled.result as bigint) : (rawBalance * a.multiplier) / a.wadPrecision;
    return { assetAddress: a.address, rawBalance, scaledBalance, decimals: a.decimals };
  });
}

export async function getUsdcBalance(owner: Address): Promise<bigint> {
  const client = getServerPublicClient();
  try {
    return await client.readContract({ address: USDC_ADDRESS, abi: b20AssetAbi, functionName: "balanceOf", args: [owner] });
  } catch {
    return 0n;
  }
}

/** Fill missing logos from the market-data provider (best effort, cached). */
export async function enrichLogos(assets: B20Asset[]): Promise<B20Asset[]> {
  const md = getMarketDataProvider();
  await Promise.all(
    assets
      .filter((a) => !a.logoURI)
      .map(async (a) => {
        const meta = await md.getTokenMetadata(a.address);
        if (meta?.logoURI) a.logoURI = meta.logoURI;
      }),
  );
  return assets;
}

/** Force refresh of cached metadata (admin / event-triggered). */
export function invalidateAssetCaches(): void {
  invalidate("b20:");
}

export interface DiscoveredCandidate {
  token: Address;
  name: string;
  symbol: string;
  blockNumber: bigint;
  txHash?: `0x${string}`;
  underlying: string;
  chainlinkFeed: Address | null;
  /** The oracle registry answers 1e18 for any address, so it is informational only. */
  oracleRegistered: boolean;
  /** EOA that sent the `createB20` transaction. */
  creator: Address | null;
  /** Issuer identity, matching onchain symbol, positive supply, DEX liquidity and a two-way swap route. */
  eligible: boolean;
  reason: string;
}

/**
 * Rechecks the issuer list and saved candidates as well as recent B20Created events.
 * A token may wait months for liquidity: its old creation event must not limit its readiness check.
 * API listings establish issuer identity; event-only candidates require the known Coinbase creator.
 */
export async function discoverNewAssets(lookbackBlocks = 60_000n): Promise<DiscoveredCandidate[]> {
  const client = getServerPublicClient();
  const [stored, listings] = await Promise.all([
    getRepos().discoveredAssets.list(),
    getCoinbaseStockListings().catch((err) => {
      metrics.count("b20.discover.coinbase", false, err instanceof Error ? err.message : String(err));
      return [];
    }),
  ]);
  const storedById = new Map(stored.map((r) => [canonicalId(r.address), r]));
  const bootstrapIds = new Set(CURATED_B20_ASSETS.map((e) => canonicalId(e.address)));
  type Candidate = { token: Address; name: string; symbol: string; blockNumber: bigint; txHash?: `0x${string}`; creator?: Address; issuerListed?: boolean };
  const raw = new Map<string, Candidate>();
  // Revisit pending tokens even when their creation event has aged out of the scan window.
  for (const row of stored) {
    if (row.verification === "disabled" || bootstrapIds.has(canonicalId(row.address)) || !isAddress(row.address, { strict: false })) continue;
    raw.set(canonicalId(row.address), { token: getAddress(row.address.toLowerCase()), name: row.name, symbol: row.symbol, blockNumber: BigInt(row.blockNumber), creator: row.creator });
  }
  for (const listing of listings) {
    const id = canonicalId(listing.address);
    if (bootstrapIds.has(id) || storedById.get(id)?.verification === "disabled") continue;
    raw.set(id, { ...raw.get(id), token: listing.address, name: listing.name, symbol: listing.symbol, blockNumber: BigInt(storedById.get(id)?.blockNumber ?? 0), issuerListed: true });
  }
  const latest = await client.getBlockNumber();
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const step = 9_999n;
  for (let from = fromBlock; from <= latest; from += step + 1n) {
    const to = from + step > latest ? latest : from + step;
    try {
      const logs = await client.getContractEvents({ address: B20_FACTORY_ADDRESS, abi: b20FactoryAbi, eventName: "B20Created", fromBlock: from, toBlock: to });
      for (const log of logs) {
        const token = log.args.token;
        const symbol = log.args.symbol ?? "";
        if (!token || Number(log.args.variant ?? 0) !== 0 || findCuratedAsset(token)) continue;
        if (!/^[A-Z0-9.]{1,7}c$/.test(symbol)) continue; // Coinbase naming: ticker + lowercase c
        const id = canonicalId(token);
        if (storedById.get(id)?.verification === "disabled") continue;
        raw.set(id, { ...raw.get(id), token: getAddress(token.toLowerCase()), name: log.args.name ?? "", symbol, blockNumber: log.blockNumber, txHash: log.transactionHash });
      }
    } catch (err) {
      metrics.count("b20.discover", false, err instanceof Error ? err.message : String(err));
      break;
    }
  }
  const out: DiscoveredCandidate[] = [];
  const known = new Map([
    ...allAssetEntries().map((e) => [e.underlying.toUpperCase(), canonicalId(e.address)] as const),
    ...stored.filter((r) => r.verification === "verified" && r.underlying).map((r) => [r.underlying!.toUpperCase(), canonicalId(r.address)] as const),
  ]);
  const creators = new Set(COINBASE_B20_CREATORS.map((a) => a.toLowerCase()));
  const candidates = [...raw.values()].filter((c) => /^[A-Z0-9.]{1,7}c$/.test(c.symbol));
  // Resolve event creators in a bounded batch before asking price APIs about tokens. This keeps
  // copycat stocks out of the slower GeckoTerminal fallback and avoids sequential transaction RPCs.
  await filterWithConcurrency(candidates, async (candidate) => {
    if (candidate.txHash && !candidate.creator) {
      const tx = await client.getTransaction({ hash: candidate.txHash }).catch(() => null);
      candidate.creator = tx?.from;
    }
    return true;
  });
  // Identity and issuance are checked before asking DEX APIs about the many unissued tokens.
  const state = await client.multicall({ contracts: candidates.flatMap((c) => [
    { address: c.token, abi: b20AssetAbi, functionName: "symbol" } as const,
    { address: c.token, abi: b20AssetAbi, functionName: "totalSupply" } as const,
    { address: B20_FACTORY_ADDRESS, abi: b20FactoryAbi, functionName: "isB20", args: [c.token] } as const,
    { address: c.token, abi: b20AssetAbi, functionName: "isPaused", args: [B20_PAUSABLE_FEATURE.TRANSFER] } as const,
    { address: c.token, abi: b20AssetAbi, functionName: "decimals" } as const,
  ]), allowFailure: true }).catch(() => []);
  const issued = candidates.filter((c, i) => state[i * 5 + 1]?.status === "success" && (state[i * 5 + 1].result as bigint) > 0n && (c.issuerListed || (c.creator && creators.has(c.creator.toLowerCase())) || storedById.get(canonicalId(c.token))?.verification === "verified"));
  const markets = await getMarketDataProvider().getTokenMarkets(issued.map((c) => c.token)).catch(() => new Map());
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const underlying = c.symbol.slice(0, -1).toUpperCase();
    const feed = await findCoinbaseFeed(underlying).catch(() => null);
    const oracle = await (
      feed && (c.issuerListed || (c.creator && creators.has(c.creator.toLowerCase())) || storedById.get(canonicalId(c.token))?.verification === "verified") ? client.readContract({ address: STOCK_ORACLE_REGISTRY_ADDRESS, abi: stockOracleRegistryAbi, functionName: "getOracleParams", args: [c.token] }).catch(() => null) : Promise.resolve(null)
    );
    const oracleRegistered = !!oracle && (oracle as readonly [bigint, boolean])[0] > 0n;
    const creator = c.creator ?? null;
    const reasons: string[] = [];
    if (known.has(underlying) && known.get(underlying) !== canonicalId(c.token)) reasons.push(`${underlying} already listed`);
    if (!c.issuerListed && storedById.get(canonicalId(c.token))?.verification !== "verified" && (!creator || !creators.has(creator.toLowerCase()))) reasons.push("issuer is not verified by Coinbase's list or deployer");
    const r = state.slice(i * 5, i * 5 + 5);
    if (r[0]?.status !== "success" || r[0].result !== c.symbol) reasons.push("onchain symbol does not match the listing");
    if (r[1]?.status !== "success" || (r[1].result as bigint) <= 0n) reasons.push("no confirmed token supply");
    if (r[2]?.status !== "success" || r[2].result !== true) reasons.push("token is not a confirmed B20 asset");
    if (r[3]?.status !== "success" || r[3].result !== false) reasons.push("transfers are paused or unknown");
    if (r[4]?.status !== "success" || !Number.isInteger(Number(r[4].result)) || Number(r[4].result) < 0 || Number(r[4].result) > 36) reasons.push("token decimals are unknown or unsupported");
    const marketReason = marketListingBlockedReason(markets.get(canonicalId(c.token)));
    if (marketReason) reasons.push(marketReason);
    if (reasons.length === 0) known.set(underlying, canonicalId(c.token));
    out.push({ ...c, underlying, chainlinkFeed: feed?.proxyAddress ?? storedById.get(canonicalId(c.token))?.chainlinkFeed ?? null, oracleRegistered, creator, eligible: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : "eligible" });
  }
  await filterWithConcurrency(out.filter((c) => c.eligible), async (candidate) => {
    const index = candidates.findIndex((c) => canonicalId(c.token) === canonicalId(candidate.token));
    if (!await hasTwoWayStockRoute(candidate.token, Number(state[index * 5 + 4].result))) {
      candidate.eligible = false;
      candidate.reason = "no confirmed two-way USDC swap route";
    }
    return candidate.eligible;
  });
  return out;
}

const discoveryState = (globalThis as unknown as { __bstocksDiscovery?: { lastSyncAt: number | null; lastScanBlocks: number; candidates: number; autoVerified: number; active: number; lastError: string | null } }).__bstocksDiscovery ??= { lastSyncAt: null, lastScanBlocks: 0, candidates: 0, autoVerified: 0, active: 0, lastError: null };
(globalThis as unknown as { __bstocksDiscovery?: typeof discoveryState }).__bstocksDiscovery = discoveryState;

export function discoveryStatus() {
  return { ...discoveryState, discovered: discoveredEntries().map((e) => e.underlying) };
}

function toEntry(d: DiscoveredAsset): CuratedAssetEntry | null {
  if (!d.underlying) return null;
  const tags = (d.tags && d.tags.length ? d.tags : ["other"]) as CuratedAssetEntry["tags"];
  return { address: d.address, underlying: d.underlying, chainlinkFeed: d.chainlinkFeed, tags };
}

const DISCOVERED_REGISTRY_KEY = "registry:b20:discovered";

/**
 * Reload at most once a minute per instance; admin/discovery writes force a refresh.
 *
 * Memory only, on purpose. The shared tier would save nothing (the list is one storage read either
 * way) and it would let any process on the same store, a local dev server or an older build with a
 * different idea of a valid entry, hand its list to every other instance.
 */
export async function loadDiscoveredRegistry(force = false): Promise<number> {
  if (force) await invalidate(DISCOVERED_REGISTRY_KEY);
  const entries = await cached(DISCOVERED_REGISTRY_KEY, { ttlMs: 60_000 }, async () => {
    // The strict read: the ordinary one answers an outage with an empty list, which would unlist
    // every discovered stock on every instance for the length of this window.
    const rows = await getRepos().discoveredAssets.listStrict();
    return rows.filter((r) => r.verification === "verified").map(toEntry).filter((e): e is CuratedAssetEntry => e !== null);
  });
  const changed = JSON.stringify(discoveredEntries()) !== JSON.stringify(entries);
  setDiscoveredEntries(entries);
  discoveryState.active = discoveredEntries().length;
  if (changed) invalidateAssetCaches();
  return discoveryState.active;
}

/**
 * Bring this instance's registry up to date before a synchronous lookup. A page that asks
 * `findCuratedAsset` on a cold instance would otherwise answer 404 for every discovered stock
 * until some other request happened to load the list.
 */
export async function ensureDiscoveredRegistry(): Promise<void> {
  await refreshDiscoveredRegistry();
}

async function refreshDiscoveredRegistry(): Promise<void> {
  try {
    await loadDiscoveredRegistry();
  } catch (err) {
    // Storage failure keeps the current known registry; it does not take Markets down.
    metrics.count("b20.registry", false, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Discovery sync: Coinbase list + saved pending tokens + events → verify issuer, token and
 * DEX liquidity and two-way USDC routes → store → refresh. An admin "disabled" flag always wins.
 * Runs at boot and every 30 minutes, so a new Coinbase listing appears without a deploy.
 */
/** Traffic-driven light discovery: at most one scan per interval per instance, off the request path. */
let lastOpportunisticScan = 0;
let opportunisticInflight = false;
export async function maybeScanInBackground(intervalMs = 30 * 60_000): Promise<void> {
  const now = Date.now();
  if (opportunisticInflight || now - lastOpportunisticScan < intervalMs) return;
  opportunisticInflight = true;
  lastOpportunisticScan = now;
  try {
    await syncDiscoveredAssets({ lookbackBlocks: 30_000n });
  } catch {
    /* logged inside; next window retries */
  } finally {
    opportunisticInflight = false;
  }
}

export async function syncDiscoveredAssets(opts: { lookbackBlocks?: bigint } = {}): Promise<ReturnType<typeof discoveryStatus>> {
  const repos = getRepos();
  try {
    const found = await discoverNewAssets(opts.lookbackBlocks ?? 60_000n);
    const existing = new Map((await repos.discoveredAssets.listStrict()).map((r) => [r.address.toLowerCase(), r]));
    const rows: DiscoveredAsset[] = found.map((f) => {
      const prev = existing.get(f.token.toLowerCase());
      const autoVerify = f.eligible && prev?.verification !== "disabled";
      return {
        address: f.token,
        name: f.name,
        symbol: f.symbol,
        blockNumber: Number(f.blockNumber),
        verification: prev?.verification === "disabled" ? "disabled" : autoVerify ? "verified" : (prev?.verification ?? "discovered"),
        updatedAt: Date.now(),
        underlying: f.underlying,
        chainlinkFeed: f.chainlinkFeed ?? undefined,
        tags: prev?.tags?.length ? prev.tags : ["other"],
        eligible: f.eligible,
        autoVerified: autoVerify || (prev?.autoVerified ?? false),
        creator: f.creator ?? undefined,
        reason: f.reason,
      };
    });
    if (rows.length > 0) {
      await repos.discoveredAssets.upsert(rows);
      for (const r of rows) if (r.verification === "verified" && existing.get(r.address.toLowerCase())?.verification !== "verified") await repos.discoveredAssets.autoVerify(r.address);
    }
    discoveryState.lastSyncAt = Date.now();
    discoveryState.lastScanBlocks = Number(opts.lookbackBlocks ?? 60_000n);
    discoveryState.candidates = found.length;
    discoveryState.autoVerified = rows.filter((r) => r.autoVerified).length;
    discoveryState.lastError = null;
    for (const r of rows.filter((r) => r.verification === "verified" && !existing.get(r.address.toLowerCase()))) metrics.count("b20.discover.autoVerified", true, `${r.symbol} ${r.address}`);
  } catch (err) {
    discoveryState.lastError = err instanceof Error ? err.message : String(err);
    metrics.count("b20.discover", false, discoveryState.lastError);
  }
  // A reload that cannot read storage leaves the registry as it was; the run still reports.
  await loadDiscoveredRegistry(true).catch((err) => {
    discoveryState.lastError ??= err instanceof Error ? err.message : String(err);
    metrics.count("b20.registry", false, discoveryState.lastError);
  });
  return discoveryStatus();
}

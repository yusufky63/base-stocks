import type { Address } from "viem";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { b20AssetAbi, b20FactoryAbi, B20_PAUSABLE_FEATURE, B20_POLICY_SCOPE, stockOracleRegistryAbi } from "@/lib/b20/abi";
import { allAssetEntries, canonicalId, discoveredEntries, findCuratedAsset, setDiscoveredEntries } from "@/lib/b20/registry";
import { findCoinbaseFeed } from "@/providers/market-data/chainlink/directory";
import { getRepos, type DiscoveredAsset } from "@/db/repositories";
import { WAD } from "@/lib/b20/math";
import { B20_FACTORY_ADDRESS, COINBASE_B20_CREATORS, STOCK_ORACLE_REGISTRY_ADDRESS, USDC_ADDRESS } from "@/config/chain";
import { serverEnv } from "@/config/env";
import type { AssetBalance, B20Asset, CuratedAssetEntry, OracleState, PendingMultiplier } from "@/domain/asset";
import { cached, TTL, invalidate } from "@/lib/cache";
import { readFeeds, isStale } from "@/providers/market-data/chainlink/reader";
import { classifyFreshness, isUsMarketOpen } from "@/lib/market-hours";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { getMarketDataProvider } from "@/providers/market-data";

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
  totalSupply: bigint;
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

/** Live state: multiplier, pause flags, oracle registry. Short cache. */
async function loadLiveState(entries: readonly CuratedAssetEntry[]): Promise<Map<string, LiveState>> {
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
    out.set(canonicalId(e.address), {
      multiplier: m?.status === "success" ? (m.result as bigint) : WAD,
      transferPaused: p?.status === "success" ? (p.result as boolean) : false,
      oracleRegistryPaused: oracle ? oracle[1] : null,
      oracleRegistryMultiplier: oracle ? oracle[0] : null,
      totalSupply: s?.status === "success" ? (s.result as bigint) : 0n,
      pendingMultiplier,
    });
  });
  return out;
}

function buildOracleState(entry: CuratedAssetEntry, live: LiveState, feed: { answer: bigint; updatedAt: bigint; decimals: number } | null): OracleState | undefined {
  if (!feed) return undefined;
  const threshold = serverEnv().ORACLE_STALENESS_SECONDS;
  const paused = live.oracleRegistryPaused ?? false;
  const marketOpen = isUsMarketOpen();
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(feed.updatedAt);
  return {
    feed: entry.chainlinkFeed,
    answer: feed.answer,
    updatedAt: feed.updatedAt,
    decimals: feed.decimals,
    paused,
    stale: isStale(feed.updatedAt, threshold),
    staleAfterSeconds: threshold,
    freshness: classifyFreshness({ ageSeconds, thresholdSeconds: threshold, paused, marketOpen }),
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
  const [meta, live, feeds] = await Promise.all([
    cached(`b20:meta:${entries.map((e) => e.address).join(",")}`, TTL.assetMetadata, () => loadStaticMeta(entries)),
    cached(`b20:live:${entries.map((e) => e.address).join(",")}`, TTL.oracle, () => loadLiveState(entries)),
    cached(`b20:feeds:${entries.map((e) => e.chainlinkFeed).join(",")}`, TTL.oracle, () => readFeeds(entries.map((e) => e.chainlinkFeed))),
  ]);
  const now = Date.now();
  const assets: B20Asset[] = [];
  for (const e of entries) {
    const id = canonicalId(e.address);
    const m = meta.get(id);
    const l: LiveState = live.get(id) ?? { multiplier: WAD, transferPaused: false, oracleRegistryPaused: null, oracleRegistryMultiplier: null, totalSupply: 0n, pendingMultiplier: undefined };
    const f = feeds.get(e.chainlinkFeed.toLowerCase()) ?? null;
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
      totalSupply: l.totalSupply,
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
  return assembleAssets(allAssetEntries());
}

/** Single asset by canonical address. Returns null when not canonical. */
export async function getAsset(address: string): Promise<B20Asset | null> {
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
  txHash: `0x${string}`;
  underlying: string;
  chainlinkFeed: Address | null;
  /** The oracle registry answers 1e18 for any address, so it is informational only. */
  oracleRegistered: boolean;
  /** EOA that sent the `createB20` transaction. */
  creator: Address | null;
  /** True only when the token was created by Coinbase's known deployer, Chainlink lists a "Coinbase <TICKER>" feed and the ticker is not already listed. Copycat "NVDAc" tokens exist by the dozen. */
  eligible: boolean;
  reason: string;
}

/**
 * Scans the factory's `B20Created` events (variant 0 = ASSET) over a bounded recent range and keeps
 * only tokens that look like Coinbase stocks. Tens of thousands of B20 tokens exist on Base, so the
 * symbol convention (`NVDAc`) is applied while decoding; only the few candidates cost extra reads.
 */
export async function discoverNewAssets(lookbackBlocks = 60_000n): Promise<DiscoveredCandidate[]> {
  const client = getServerPublicClient();
  const latest = await client.getBlockNumber();
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const step = 9_999n;
  const raw: Array<{ token: Address; name: string; symbol: string; blockNumber: bigint; txHash: `0x${string}` }> = [];
  for (let from = fromBlock; from <= latest; from += step + 1n) {
    const to = from + step > latest ? latest : from + step;
    try {
      const logs = await client.getContractEvents({ address: B20_FACTORY_ADDRESS, abi: b20FactoryAbi, eventName: "B20Created", fromBlock: from, toBlock: to });
      for (const log of logs) {
        const token = log.args.token;
        const symbol = log.args.symbol ?? "";
        if (!token || Number(log.args.variant ?? 0) !== 0 || findCuratedAsset(token)) continue;
        if (!/^[A-Z0-9.]{1,7}c$/.test(symbol)) continue; // Coinbase naming: ticker + lowercase c
        raw.push({ token, name: log.args.name ?? "", symbol, blockNumber: log.blockNumber, txHash: log.transactionHash });
      }
    } catch (err) {
      metrics.count("b20.discover", false, err instanceof Error ? err.message : String(err));
      break;
    }
  }
  const out: DiscoveredCandidate[] = [];
  const known = new Set(allAssetEntries().map((e) => e.underlying.toUpperCase()));
  const creators = new Set(COINBASE_B20_CREATORS.map((a) => a.toLowerCase()));
  for (const c of raw) {
    const underlying = c.symbol.slice(0, -1).toUpperCase();
    const [feed, oracle, tx] = await Promise.all([
      findCoinbaseFeed(underlying),
      client.readContract({ address: STOCK_ORACLE_REGISTRY_ADDRESS, abi: stockOracleRegistryAbi, functionName: "getOracleParams", args: [c.token] }).catch(() => null),
      client.getTransaction({ hash: c.txHash }).catch(() => null),
    ]);
    const oracleRegistered = !!oracle && (oracle as readonly [bigint, boolean])[0] > 0n;
    const creator = (tx?.from as Address | undefined) ?? null;
    const reasons: string[] = [];
    if (!feed) reasons.push("no Chainlink Coinbase feed");
    if (known.has(underlying)) reasons.push(`${underlying} already listed`);
    if (!creator || !creators.has(creator.toLowerCase())) reasons.push("creator is not Coinbase's deployer");
    out.push({ ...c, underlying, chainlinkFeed: feed?.proxyAddress ?? null, oracleRegistered, creator, eligible: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : "eligible" });
  }
  return out;
}

const discoveryState = (globalThis as unknown as { __bstocksDiscovery?: { lastSyncAt: number | null; lastScanBlocks: number; candidates: number; autoVerified: number; active: number; lastError: string | null } }).__bstocksDiscovery ??= { lastSyncAt: null, lastScanBlocks: 0, candidates: 0, autoVerified: 0, active: 0, lastError: null };
(globalThis as unknown as { __bstocksDiscovery?: typeof discoveryState }).__bstocksDiscovery = discoveryState;

export function discoveryStatus() {
  return { ...discoveryState, discovered: discoveredEntries().map((e) => e.underlying) };
}

function toEntry(d: DiscoveredAsset): CuratedAssetEntry | null {
  if (!d.underlying || !d.chainlinkFeed) return null;
  const tags = (d.tags && d.tags.length ? d.tags : ["other"]) as CuratedAssetEntry["tags"];
  return { address: d.address, underlying: d.underlying, chainlinkFeed: d.chainlinkFeed, tags };
}

/** Load verified discovered stocks from storage into the live registry (boot, after admin changes). */
export async function loadDiscoveredRegistry(): Promise<number> {
  const rows = await getRepos().discoveredAssets.list();
  const entries = rows.filter((r) => r.verification === "verified").map(toEntry).filter((e): e is CuratedAssetEntry => e !== null);
  setDiscoveredEntries(entries);
  discoveryState.active = entries.length;
  invalidateAssetCaches();
  return entries.length;
}

/**
 * Discovery sync: scan → store candidates → auto-verify the eligible ones (Chainlink feed + oracle
 * registry + Coinbase naming; an admin "disabled" flag always wins) → refresh the live registry.
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
    const existing = new Map((await repos.discoveredAssets.list()).map((r) => [r.address.toLowerCase(), r]));
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
      for (const r of rows) if (r.verification !== existing.get(r.address.toLowerCase())?.verification) await repos.discoveredAssets.setVerification(r.address, r.verification);
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
  await loadDiscoveredRegistry();
  return discoveryStatus();
}

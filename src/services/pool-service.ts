import { formatUnits, parseAbiItem, type Address, type Hex } from "viem";
import type { B20Asset } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import type { PoolClaim, PoolLeg, PoolLegView, PoolOnchainState, PoolRecord, PoolView } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { getServerPublicClient, getLogPublicClient } from "@/lib/viem/server-client";
import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { reverseResolve } from "@/services/basename-service";
import { GIFT_POOL_ADDRESS, giftPoolAbi, isPoolDeployed } from "@/lib/pool";
import { findRecentLog } from "@/lib/gift/logs";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { blockTimes } from "./receipt-service";
import { verifyPoolCreate, type PoolCreateFacts, type Verdict } from "./tx-verify-service";

const ZERO = "0x0000000000000000000000000000000000000000";
/** Base produces ~43k blocks a day at 2s; one sweep never looks further back than a pool can live. */
const MAX_RECONCILE_BLOCKS = 500_000n;
/** A stuck draft is looked for on the chain between these ages (see gift-service for the reasoning). */
const REPAIR_MIN_AGE_MS = 5 * 60_000;
const REPAIR_MAX_AGE_MS = 24 * 3600_000;

const POOL_CLAIMED_EVENT = parseAbiItem("event PoolClaimed(bytes32 indexed id, address indexed recipient, uint32 index)");
const POOL_CREATED_EVENT = giftPoolAbi.find((x) => x.type === "event" && x.name === "PoolCreated")!;

export const POOL_ID_RE = /^pool_[a-z0-9_]{4,60}$/i;

/* ------------------------------ onchain reads ----------------------------- */

/**
 * The contract's own view of many pools in one multicall: three reads per pool, one round trip
 * for the whole directory. An entry is `null` when pools are not deployed or that pool's read
 * failed, so callers can fall back per pool.
 */
export async function readPoolsOnchain(onchainIds: Hex[]): Promise<Map<string, PoolOnchainState | null>> {
  const out = new Map<string, PoolOnchainState | null>();
  if (onchainIds.length === 0) return out;
  for (const id of onchainIds) out.set(id.toLowerCase(), null);
  if (!isPoolDeployed()) return out;
  const address = GIFT_POOL_ADDRESS as Address;
  const client = getServerPublicClient();
  try {
    const results = await client.multicall({
      contracts: onchainIds.flatMap((id) => [
        { address, abi: giftPoolAbi, functionName: "pools" as const, args: [id] as const },
        { address, abi: giftPoolAbi, functionName: "legsOf" as const, args: [id] as const },
        { address, abi: giftPoolAbi, functionName: "remainingSlots" as const, args: [id] as const },
      ]),
      allowFailure: true,
    });
    onchainIds.forEach((id, i) => {
      const poolRes = results[i * 3]!;
      const legsRes = results[i * 3 + 1]!;
      const remainingRes = results[i * 3 + 2]!;
      if (poolRes.status !== "success") return;
      const [creator, gate, slots, claimed, expiry, lockedUntil, cancelled] = poolRes.result as readonly [Address, Address, number, number, bigint, bigint, boolean];
      const legs = legsRes.status === "success" ? (legsRes.result as readonly { token: Address; amountPerClaim: bigint; withdrawn: boolean }[]) : [];
      out.set(id.toLowerCase(), {
        exists: creator !== ZERO,
        creator,
        gate,
        slots: Number(slots),
        claimed: Number(claimed),
        expiry: Number(expiry) * 1000,
        lockedUntil: Number(lockedUntil) * 1000,
        cancelled,
        remainingSlots: remainingRes.status === "success" ? Number(remainingRes.result) : 0,
        legs: legs.map((l) => ({ token: l.token, amountPerClaim: l.amountPerClaim.toString(), withdrawn: l.withdrawn })),
      });
    });
  } catch (err) {
    metrics.count("pool.read", false, err instanceof Error ? err.message : String(err));
  }
  return out;
}

/** One pool's onchain state. `null` when pools are not deployed or the read fails. */
export async function readPoolOnchain(onchainId: Hex): Promise<PoolOnchainState | null> {
  return (await readPoolsOnchain([onchainId])).get(onchainId.toLowerCase()) ?? null;
}

/** Live status for the UI: the chain wins over whatever the database last recorded. */
export function effectiveStatus(record: PoolRecord, onchain: PoolOnchainState | null): PoolRecord["status"] {
  if (record.status === "draft" || record.status === "failed") return record.status;
  if (onchain?.cancelled) return "cancelled";
  if (Date.now() > (onchain?.exists ? onchain.expiry : record.expiry)) return "expired";
  return onchain?.exists ? "live" : record.status;
}

/* -------------------------------- views ---------------------------------- */

/** Prices and assets fetched once for a whole page of pools. */
interface Market {
  assets: B20Asset[];
  prices: Map<string, PriceView> | null;
}

async function marketFor(legSets: PoolLeg[][]): Promise<Market> {
  const assets = await getAssets().catch(() => [] as B20Asset[]);
  const wanted = new Set(legSets.flat().map((l) => l.token.toLowerCase()));
  const involved = assets.filter((a) => wanted.has(a.canonicalId));
  const prices = involved.length > 0 ? await getPriceViews(involved).catch(() => null) : null;
  return { assets, prices };
}

/** Legs resolved for display. The chain's legs win when they have been read; the record's are the draft's word. */
function legViews(record: PoolRecord, onchain: PoolOnchainState | null, market: Market): { legs: PoolLegView[]; usdPerClaim: number | null } {
  const source: PoolLeg[] = onchain?.exists && onchain.legs.length > 0 ? onchain.legs : record.legs;
  let usdTotal = 0;
  let priced = source.length > 0;
  const legs = source.map((leg): PoolLegView => {
    const asset = market.assets.find((a) => a.canonicalId === leg.token.toLowerCase());
    const raw = BigInt(leg.amountPerClaim);
    const decimals = asset?.decimals ?? 8;
    const scaled = asset ? (raw * asset.multiplier) / asset.wadPrecision : raw;
    const price = asset ? (market.prices?.get(asset.canonicalId)?.displayUsd ?? null) : null;
    const usd = price !== null ? Number(formatUnits(raw, decimals)) * price : null;
    if (usd === null) priced = false;
    else usdTotal += usd;
    return {
      token: leg.token,
      amountPerClaim: leg.amountPerClaim,
      symbol: asset?.symbol ?? "?",
      underlying: asset?.underlying ?? "stock",
      decimals,
      logoURI: asset?.logoURI,
      scaledPerClaim: scaled.toString(),
      usdPerClaim: usd,
    };
  });
  return { legs, usdPerClaim: priced ? usdTotal : null };
}

/**
 * Views for a page of pools with a fixed number of round trips, however long the page: one
 * multicall for every pool's onchain state, one asset list, one price fetch, one claim-count
 * query for the pools the chain did not answer for, and one (cached) reverse-resolve per creator.
 */
export async function buildPoolViews(records: PoolRecord[]): Promise<PoolView[]> {
  if (records.length === 0) return [];
  const repos = getRepos();
  const [onchainById, market] = await Promise.all([readPoolsOnchain(records.map((r) => r.onchainId)), marketFor(records.map((r) => r.legs))]);
  const unanswered = records.filter((r) => !onchainById.get(r.onchainId.toLowerCase())?.exists).map((r) => r.id);
  const [counts, names] = await Promise.all([
    unanswered.length > 0 ? repos.poolClaims.countByPools(unanswered).catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
    Promise.all([...new Set(records.map((r) => r.creator.toLowerCase()))].map(async (c) => [c, await reverseResolve(c as Address).catch(() => null)] as const)).then((pairs) => new Map(pairs)),
  ]);
  return records.map((record) => {
    const onchain = onchainById.get(record.onchainId.toLowerCase()) ?? null;
    const { legs, usdPerClaim } = legViews(record, onchain, market);
    return {
      pool: { ...record, status: effectiveStatus(record, onchain) },
      onchain,
      legs,
      usdPerClaim,
      claimCount: onchain?.exists ? onchain.claimed : (counts.get(record.id) ?? 0),
      creatorBasename: names.get(record.creator.toLowerCase()) ?? null,
    };
  });
}

export async function buildPoolView(record: PoolRecord): Promise<PoolView> {
  return (await buildPoolViews([record]))[0]!;
}

export async function getPoolView(id: string): Promise<PoolView | null> {
  if (!POOL_ID_RE.test(id)) return null;
  let record = await getRepos().pools.get(id);
  if (!record) return null;
  // A draft the contract already knows is a record the browser never finished writing.
  if (record.status === "draft") record = (await repairDraftPool(record).catch(() => null)) ?? record;
  if (record.status === "draft") return null;
  return buildPoolView(record);
}

/** Same as `getPoolView` but throws the typed 404 the API routes expect. */
export async function requirePool(id: string): Promise<PoolRecord> {
  if (!POOL_ID_RE.test(id)) throw new AppError("NOT_FOUND", "Pool not found", 404);
  const record = await getRepos().pools.get(id);
  if (!record) throw new AppError("NOT_FOUND", "Pool not found", 404);
  return record;
}

export async function listPublicPools(limit = 40): Promise<PoolView[]> {
  const records = await getRepos().pools.listPublic(limit).catch(() => []);
  return buildPoolViews(records);
}

/* ------------------------------- settlement ------------------------------- */

/**
 * The patch a funding verdict earns. Proven: the chain's gate, slots, expiry, lock and legs
 * replace whatever the browser filed, because the record only ever carried the creator's intent.
 * Pending: the hash is kept for the sweep. Reverted: failed. A mismatch is refused to the caller.
 */
export function poolFundingPatch(pool: PoolRecord, txHash: `0x${string}`, v: Verdict<PoolCreateFacts>, gateSigner: Address | null): Partial<PoolRecord> {
  if (v.ok) {
    // The gate address decides how claims work, whatever the draft said: address(0) is open,
    // the campaign signer is quest-gated, anything else is a link key.
    const gateMode: PoolRecord["gateMode"] = v.gate === ZERO ? "open" : gateSigner && v.gate.toLowerCase() === gateSigner.toLowerCase() ? "signer" : "link";
    return {
      txHash,
      status: pool.status === "draft" || pool.status === "failed" ? "submitted" : pool.status,
      gateAddress: v.gate,
      gateMode,
      slots: v.slots,
      expiry: v.expiry,
      lockedUntil: v.lockedUntil,
      legs: v.legs,
      verifiedAt: Date.now(),
      // `null` rather than `undefined`: the repo skips undefined fields, and a stale note must go.
      verifyNote: null as unknown as undefined,
    };
  }
  if (v.state === "mismatch") throw new AppError("TX_MISMATCH", v.reason, 400);
  if (v.state === "reverted") return { txHash, status: "failed", verifyNote: "reverted" };
  return { txHash, status: pool.status === "draft" ? "submitted" : pool.status };
}

/* --------------------------------- repair --------------------------------- */

/**
 * A draft the contract knows: finds its `PoolCreated` by the indexed id, verifies it like any
 * reported hash and writes the result. Returns the updated record, or null when the chain has
 * no such pool (never funded) or nothing could be found.
 */
export async function repairDraftPool(pool: PoolRecord, gateSigner: Address | null = null): Promise<PoolRecord | null> {
  if (pool.status !== "draft" || !isPoolDeployed()) return null;
  const onchain = await readPoolOnchain(pool.onchainId);
  if (!onchain?.exists) return null;
  const log = await findRecentLog(getLogPublicClient(), { address: GIFT_POOL_ADDRESS as Address, event: POOL_CREATED_EVENT, args: { id: pool.onchainId } });
  if (!log?.transactionHash) return null;
  const patch = poolFundingPatch(pool, log.transactionHash, await verifyPoolCreate(pool, log.transactionHash), gateSigner);
  const updated = await getRepos().pools.update(pool.id, patch);
  metrics.count("pool.repair", true, pool.id);
  return updated ?? { ...pool, ...patch };
}

/** Sweep step: every draft old enough to be stuck and young enough to be worth a read. */
export async function repairDraftPools(gateSigner: Address | null, limit = 300): Promise<{ checked: number; repaired: number }> {
  if (!isPoolDeployed()) return { checked: 0, repaired: 0 };
  const now = Date.now();
  const drafts = (await getRepos().pools.listAll(limit).catch(() => [])).filter((p) => p.status === "draft" && now - p.createdAt >= REPAIR_MIN_AGE_MS && now - p.createdAt <= REPAIR_MAX_AGE_MS);
  let repaired = 0;
  for (const p of drafts) {
    try {
      if (await repairDraftPool(p, gateSigner)) repaired += 1;
    } catch (err) {
      metrics.count("pool.repair", false, err instanceof Error ? err.message : String(err));
    }
  }
  return { checked: drafts.length, repaired };
}

/* ----------------------------- reconciliation ----------------------------- */

/**
 * Fills in claims the app never saw. The claim page writes its row as soon as the wallet
 * confirms, but a closed tab, a failed request or a claim submitted straight to the contract
 * would leave a gap, so `PoolClaimed` logs are the source of truth and this closes the
 * difference. Safe to run repeatedly: rows are keyed by (pool, claimant), and every row a log
 * names ends up `reconciled`, which is the one status that counts as proof.
 */
export async function reconcilePool(record: PoolRecord): Promise<{ found: number; added: number }> {
  if (!isPoolDeployed() || !record.txHash) return { found: 0, added: 0 };
  const client = getLogPublicClient();
  const repos = getRepos();
  try {
    const receipt = await client.getTransactionReceipt({ hash: record.txHash });
    const head = await client.getBlockNumber();
    const fromBlock = receipt.blockNumber > head - MAX_RECONCILE_BLOCKS ? receipt.blockNumber : head - MAX_RECONCILE_BLOCKS;
    const logs = await client.getLogs({
      address: GIFT_POOL_ADDRESS as Address,
      event: POOL_CLAIMED_EVENT,
      args: { id: record.onchainId },
      fromBlock,
      toBlock: head,
    });
    // The row's time is the block's, not the sweep's: a claim from last week is not "just now".
    const times = await blockTimes(logs.map((l) => Number(l.blockNumber)).filter((n) => Number.isFinite(n))).catch(() => new Map<number, number>());
    let added = 0;
    for (const log of logs) {
      const recipient = log.args.recipient;
      if (!recipient) continue;
      const blockNumber = log.blockNumber !== null ? Number(log.blockNumber) : undefined;
      const blockTime = blockNumber !== undefined ? times.get(blockNumber) : undefined;
      const claim: PoolClaim = {
        poolId: record.id,
        claimant: recipient,
        status: "reconciled",
        questProof: {},
        txHash: log.transactionHash ?? undefined,
        blockNumber,
        createdAt: blockTime !== undefined ? blockTime * 1000 : Date.now(),
      };
      const inserted = await repos.poolClaims.claimOnce(claim);
      if (inserted) added += 1;
      else await repos.poolClaims.update(record.id, recipient, { status: "reconciled", txHash: claim.txHash, blockNumber: claim.blockNumber }).catch(() => null);
    }
    await repos.pools.touchReconciled(record.id).catch(() => undefined);
    return { found: logs.length, added };
  } catch (err) {
    metrics.count("pool.reconcile", false, err instanceof Error ? err.message : String(err));
    return { found: 0, added: 0 };
  }
}

/** Cron entry point: reconcile the open pools visited longest ago, so every pool gets its turn. */
export async function sweepOpenPools(limit = 25): Promise<{ pools: number; added: number }> {
  if (!isPoolDeployed()) return { pools: 0, added: 0 };
  const records = await getRepos().pools.listOpen(limit).catch(() => []);
  let added = 0;
  for (const r of records) added += (await reconcilePool(r)).added;
  return { pools: records.length, added };
}

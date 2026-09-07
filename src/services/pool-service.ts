import { formatUnits, parseAbiItem, type Address, type Hex } from "viem";
import type { PoolClaim, PoolLegView, PoolOnchainState, PoolRecord, PoolView } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { getServerPublicClient, getLogPublicClient } from "@/lib/viem/server-client";
import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { reverseResolve } from "@/services/basename-service";
import { GIFT_POOL_ADDRESS, giftPoolAbi, isPoolDeployed } from "@/lib/pool";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";

const ZERO = "0x0000000000000000000000000000000000000000";
/** Base produces ~43k blocks a day at 2s; one sweep never looks further back than a pool can live. */
const MAX_RECONCILE_BLOCKS = 500_000n;

const POOL_CLAIMED_EVENT = parseAbiItem("event PoolClaimed(bytes32 indexed id, address indexed recipient, uint32 index)");

export const POOL_ID_RE = /^pool_[a-z0-9_]{4,60}$/i;

/* ------------------------------ onchain reads ----------------------------- */

/** The contract's own view of a pool. `null` when pools are not deployed or the read fails. */
export async function readPoolOnchain(onchainId: Hex): Promise<PoolOnchainState | null> {
  if (!isPoolDeployed()) return null;
  const address = GIFT_POOL_ADDRESS as Address;
  const client = getServerPublicClient();
  try {
    const [poolRes, legsRes, remainingRes] = await client.multicall({
      contracts: [
        { address, abi: giftPoolAbi, functionName: "pools", args: [onchainId] },
        { address, abi: giftPoolAbi, functionName: "legsOf", args: [onchainId] },
        { address, abi: giftPoolAbi, functionName: "remainingSlots", args: [onchainId] },
      ],
      allowFailure: true,
    });
    if (poolRes.status !== "success") return null;
    const [creator, gate, slots, claimed, expiry, lockedUntil, cancelled] = poolRes.result;
    const exists = creator !== ZERO;
    return {
      exists,
      creator,
      gate,
      slots: Number(slots),
      claimed: Number(claimed),
      expiry: Number(expiry) * 1000,
      lockedUntil: Number(lockedUntil) * 1000,
      cancelled,
      remainingSlots: remainingRes.status === "success" ? Number(remainingRes.result) : 0,
      legs:
        legsRes.status === "success"
          ? legsRes.result.map((l) => ({ token: l.token, amountPerClaim: l.amountPerClaim.toString(), withdrawn: l.withdrawn }))
          : [],
    };
  } catch (err) {
    metrics.count("pool.read", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Live status for the UI: the chain wins over whatever the database last recorded. */
export function effectiveStatus(record: PoolRecord, onchain: PoolOnchainState | null): PoolRecord["status"] {
  if (record.status === "draft" || record.status === "failed") return record.status;
  if (onchain?.cancelled) return "cancelled";
  if (Date.now() > record.expiry) return "expired";
  return onchain?.exists ? "live" : record.status;
}

/* -------------------------------- views ---------------------------------- */

async function legViews(record: PoolRecord): Promise<{ legs: PoolLegView[]; usdPerClaim: number | null }> {
  const assets = await getAssets().catch(() => []);
  const involved = assets.filter((a) => record.legs.some((l) => l.token.toLowerCase() === a.canonicalId));
  const prices = involved.length > 0 ? await getPriceViews(involved).catch(() => null) : null;

  let usdTotal = 0;
  let priced = involved.length === record.legs.length;
  const legs = record.legs.map((leg): PoolLegView => {
    const asset = assets.find((a) => a.canonicalId === leg.token.toLowerCase());
    const raw = BigInt(leg.amountPerClaim);
    const decimals = asset?.decimals ?? 8;
    const scaled = asset ? (raw * asset.multiplier) / asset.wadPrecision : raw;
    const price = asset ? (prices?.get(asset.canonicalId)?.displayUsd ?? null) : null;
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

export async function buildPoolView(record: PoolRecord): Promise<PoolView> {
  const [onchain, { legs, usdPerClaim }, claimCount, creatorBasename] = await Promise.all([
    readPoolOnchain(record.onchainId),
    legViews(record),
    getRepos().poolClaims.countByPool(record.id).catch(() => 0),
    reverseResolve(record.creator).catch(() => null),
  ]);
  return { pool: { ...record, status: effectiveStatus(record, onchain) }, onchain, legs, usdPerClaim, claimCount, creatorBasename };
}

export async function getPoolView(id: string): Promise<PoolView | null> {
  if (!POOL_ID_RE.test(id)) return null;
  const record = await getRepos().pools.get(id);
  if (!record || record.status === "draft") return null;
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
  return Promise.all(records.map((r) => buildPoolView(r)));
}

/* ----------------------------- reconciliation ----------------------------- */

/**
 * Fills in claims the app never saw. The claim page writes its row as soon as the wallet
 * confirms, but a closed tab, a failed request or a claim submitted straight to the contract
 * would leave a gap — so `PoolClaimed` logs are the source of truth and this closes the
 * difference. Safe to run repeatedly: rows are keyed by (pool, claimant).
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
    let added = 0;
    for (const log of logs) {
      const recipient = log.args.recipient;
      if (!recipient) continue;
      const claim: PoolClaim = {
        poolId: record.id,
        claimant: recipient,
        status: "reconciled",
        questProof: {},
        txHash: log.transactionHash ?? undefined,
        blockNumber: log.blockNumber !== null ? Number(log.blockNumber) : undefined,
        createdAt: Date.now(),
      };
      const inserted = await repos.poolClaims.claimOnce(claim);
      if (inserted) added += 1;
      else
        await repos.poolClaims
          .update(record.id, recipient, { status: "confirmed", txHash: claim.txHash, blockNumber: claim.blockNumber })
          .catch(() => null);
    }
    return { found: logs.length, added };
  } catch (err) {
    metrics.count("pool.reconcile", false, err instanceof Error ? err.message : String(err));
    return { found: 0, added: 0 };
  }
}

/** Cron entry point: reconcile every pool that could still be receiving claims. */
export async function sweepOpenPools(limit = 25): Promise<{ pools: number; added: number }> {
  if (!isPoolDeployed()) return { pools: 0, added: 0 };
  const records = await getRepos().pools.listOpen(limit).catch(() => []);
  let added = 0;
  for (const r of records) added += (await reconcilePool(r)).added;
  return { pools: records.length, added };
}

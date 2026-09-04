import { decodeEventLog, erc20Abi, formatUnits, type Address, type Hash } from "viem";
import type { Quest, QuestStatus } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { reverseResolve } from "@/services/basename-service";
import { b20AssetAbi } from "@/lib/b20/abi";
import { formatUsd } from "@/lib/format";

/**
 * Quest verification for gift pools. Everything here runs on the server and gates a claim
 * ticket; the contract itself knows nothing about quests, so a new quest type never needs a new
 * deployment.
 *
 * The rule this file holds to: **only checks that can be proven from the chain or from a
 * signature.** App-side records (`trade_records`) are written by an unauthenticated route and
 * are therefore treated as a lookup index, never as evidence — every purchase they point at is
 * re-verified against its transaction receipt before it counts.
 */

const DEFAULT_WITHIN_DAYS = 30;
/** How many candidate purchases we are willing to verify onchain for a single claim. */
const MAX_RECEIPTS_PER_CHECK = 8;

export interface QuestResult extends QuestStatus {
  /** Recorded on the claim row so the creator can audit who got in and why. */
  proof?: Record<string, unknown>;
}

function label(q: Quest, symbol?: string): string {
  switch (q.type) {
    case "sign-in":
      return "Sign in with your wallet";
    case "hold-basename":
      return "Own a Basename";
    case "hold-asset":
      return `Hold ${symbol ?? "the stock"}`;
    case "buy-asset":
      return `Buy ${q.minUsd ? formatUsd(q.minUsd) : "some"} of ${symbol ?? "the stock"}`;
  }
}

async function symbolFor(asset?: Address): Promise<string | undefined> {
  if (!asset) return undefined;
  const assets = await getAssets().catch(() => []);
  return assets.find((a) => a.canonicalId === asset.toLowerCase())?.underlying;
}

/* ------------------------------- verifiers ------------------------------- */

async function verifyHoldBasename(claimant: Address): Promise<QuestResult> {
  const name = await reverseResolve(claimant).catch(() => null);
  return {
    type: "hold-basename",
    label: "Own a Basename",
    done: !!name,
    detail: name ? undefined : "This wallet has no Basename yet. Claim one at base.org/names, then come back.",
    proof: name ? { basename: name } : undefined,
  };
}

async function verifyHoldAsset(q: Quest, claimant: Address): Promise<QuestResult> {
  const symbol = await symbolFor(q.assetAddress);
  const base: QuestResult = { type: "hold-asset", label: label(q, symbol), done: false };
  if (!q.assetAddress) return { ...base, detail: "This quest is misconfigured; ask the creator to fix it." };
  const min = BigInt(q.minRawAmount ?? "1");
  const balance = await getServerPublicClient()
    .readContract({ address: q.assetAddress, abi: b20AssetAbi, functionName: "balanceOf", args: [claimant] })
    .catch(() => null);
  if (balance === null) return { ...base, detail: "We could not read your balance just now. Try again in a moment." };
  const done = balance >= min;
  return {
    ...base,
    done,
    detail: done ? undefined : `You need at least ${formatUnits(min, 8)} ${symbol ?? "of this stock"} in this wallet.`,
    proof: done ? { balance: balance.toString() } : undefined,
  };
}

/**
 * "Bought at least $X of this stock recently." The app's own trade rows only tell us which
 * transactions to look at; the proof is the receipt — a successful transaction carrying an ERC-20
 * `Transfer` of that exact asset into the claimant's wallet.
 */
async function verifyBuyAsset(q: Quest, claimant: Address): Promise<QuestResult> {
  const symbol = await symbolFor(q.assetAddress);
  const base: QuestResult = { type: "buy-asset", label: label(q, symbol), done: false };
  if (!q.assetAddress) return { ...base, detail: "This quest is misconfigured; ask the creator to fix it." };

  const since = Date.now() - (q.withinDays ?? DEFAULT_WITHIN_DAYS) * 24 * 3600 * 1000;
  const trades = await getRepos().trades.listByOwner(claimant).catch(() => []);
  const candidates = trades
    .filter((t) => t.side === "buy" && t.assetAddress.toLowerCase() === q.assetAddress!.toLowerCase() && t.createdAt >= since && !!t.txHash)
    .slice(0, MAX_RECEIPTS_PER_CHECK);
  if (candidates.length === 0) {
    return { ...base, detail: `No ${symbol ?? "purchase"} found in this wallet in the last ${q.withinDays ?? DEFAULT_WITHIN_DAYS} days.` };
  }

  const client = getServerPublicClient();
  const assets = await getAssets().catch(() => []);
  const asset = assets.find((a) => a.canonicalId === q.assetAddress!.toLowerCase());
  const decimals = asset?.decimals ?? 8;
  const price = asset ? ((await getPriceViews([asset]).catch(() => null))?.get(asset.canonicalId)?.displayUsd ?? null) : null;

  let boughtRaw = 0n;
  const verifiedTxs: Hash[] = [];
  for (const t of candidates) {
    const received = await receivedFromReceipt(client, t.txHash!, q.assetAddress, claimant);
    if (received > 0n) {
      boughtRaw += received;
      verifiedTxs.push(t.txHash!);
    }
  }
  if (boughtRaw === 0n) {
    return { ...base, detail: "We could not verify that purchase onchain yet. If it just went through, wait for the confirmation and retry." };
  }

  const minUsd = q.minUsd ?? 0;
  if (minUsd <= 0) return { ...base, done: true, proof: { txs: verifiedTxs, rawAmount: boughtRaw.toString() } };
  if (price === null) {
    return { ...base, detail: "We cannot price this stock right now, so the amount cannot be checked. Try again shortly." };
  }
  const usd = Number(formatUnits(boughtRaw, decimals)) * price;
  const done = usd + 1e-9 >= minUsd;
  return {
    ...base,
    done,
    detail: done ? undefined : `Verified ${formatUsd(usd)} so far — this pool asks for ${formatUsd(minUsd)}.`,
    proof: done ? { txs: verifiedTxs, rawAmount: boughtRaw.toString(), usd } : undefined,
  };
}

/** Sum of ERC-20 `Transfer` events moving `token` into `to` in a successful transaction. */
async function receivedFromReceipt(
  client: ReturnType<typeof getServerPublicClient>,
  hash: Hash,
  token: Address,
  to: Address,
): Promise<bigint> {
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
  if (!receipt || receipt.status !== "success") return 0n;
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName !== "Transfer") continue;
      const args = decoded.args as unknown as { to: Address; value: bigint };
      if (args.to.toLowerCase() === to.toLowerCase()) total += args.value;
    } catch {
      // Not a Transfer we understand; ignore it rather than failing the whole check.
    }
  }
  return total;
}

/* --------------------------------- API ---------------------------------- */

/** Runs every quest of a pool for one address. Never throws: a failed check reads as "not done". */
export async function verifyQuests(quests: Quest[], claimant: Address): Promise<QuestResult[]> {
  return Promise.all(
    quests.map(async (q): Promise<QuestResult> => {
      try {
        switch (q.type) {
          case "sign-in":
            // Reaching this point already required a valid SIWE session for `claimant`.
            return { type: "sign-in", label: "Sign in with your wallet", done: true };
          case "hold-basename":
            return await verifyHoldBasename(claimant);
          case "hold-asset":
            return await verifyHoldAsset(q, claimant);
          case "buy-asset":
            return await verifyBuyAsset(q, claimant);
          default:
            return { type: q.type, label: "Unknown requirement", done: false, detail: "This pool asks for something this version cannot check." };
        }
      } catch {
        return { type: q.type, label: label(q), done: false, detail: "We could not check this right now. Try again in a moment." };
      }
    }),
  );
}

/** Quest labels for a pool, without running any check — used on the public pool card. */
export async function describeQuests(quests: Quest[]): Promise<QuestStatus[]> {
  return Promise.all(
    quests.map(async (q) => ({ type: q.type, label: label(q, await symbolFor(q.assetAddress)), done: false })),
  );
}

export function questProof(results: QuestResult[]): Record<string, unknown> {
  const proof: Record<string, unknown> = {};
  for (const r of results) if (r.proof) proof[r.type] = r.proof;
  return proof;
}

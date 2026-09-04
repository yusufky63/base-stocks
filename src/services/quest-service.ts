import { decodeEventLog, erc20Abi, formatUnits, type Address, type Hash } from "viem";
import { isSelfDeclared, type Quest, type QuestStatus, type QuestType } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { getAssets } from "@/services/b20-asset-service";
import { getPriceViews } from "@/services/price-service";
import { reverseResolve } from "@/services/basename-service";
import { b20AssetAbi } from "@/lib/b20/abi";
import { BSTOCKS_X_HANDLE, xIntentUrl, xProfileUrl } from "@/content/social";
import { formatUsd } from "@/lib/format";

/**
 * Quest verification for gift pools. Everything here runs on the server and gates a claim ticket;
 * the contract knows nothing about quests, so a new quest type never needs a new deployment.
 *
 * Two grades of quest, kept apart everywhere:
 *
 * - **Checked** — proven from the chain or a signature. App-side records (`trade_records`) are a
 *   lookup index, never evidence: every purchase they point at is re-read from its receipt.
 * - **Self-declared** — X steps. The free X API cannot prove a follow, a repost or a like, so the
 *   claimant confirms these about themselves and the app stores who declared what, with the
 *   timestamp. Nothing in the copy calls that "verified", because it is not.
 */

const DEFAULT_WITHIN_DAYS = 30;
/** How many candidate purchases we are willing to re-read for a single claim. */
const MAX_RECEIPTS_PER_CHECK = 8;

export interface QuestResult extends QuestStatus {
  /** Recorded on the claim row so the creator can audit who got in and why. */
  proof?: Record<string, unknown>;
}

/** Attestations a claimant has already made, keyed by quest index. */
export type Attestations = Record<string, number>;

export function readAttestations(questProof: Record<string, unknown> | undefined): Attestations {
  const raw = questProof?.attested;
  return raw && typeof raw === "object" ? (raw as Attestations) : {};
}

/* -------------------------------- labels --------------------------------- */

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
    case "follow-bstocks":
      return `Follow @${BSTOCKS_X_HANDLE} on X`;
    case "follow-x":
      return `Follow @${q.handle ?? "the creator"} on X`;
    case "repost-x":
      return "Repost the announcement on X";
    case "like-x":
      return "Like the announcement on X";
  }
}

/** Where a self-declared step sends the claimant. */
export function questActionUrl(q: Quest): string | undefined {
  switch (q.type) {
    case "follow-bstocks":
      return xProfileUrl(BSTOCKS_X_HANDLE);
    case "follow-x":
      return q.handle ? xProfileUrl(q.handle) : undefined;
    case "repost-x":
      return q.tweetUrl ? xIntentUrl("repost", q.tweetUrl) : undefined;
    case "like-x":
      return q.tweetUrl ? xIntentUrl("like", q.tweetUrl) : undefined;
    default:
      return undefined;
  }
}

async function symbolFor(asset?: Address): Promise<string | undefined> {
  if (!asset) return undefined;
  const assets = await getAssets().catch(() => []);
  return assets.find((a) => a.canonicalId === asset.toLowerCase())?.underlying;
}

/* ------------------------------- verifiers ------------------------------- */

async function verifyHoldBasename(index: number, claimant: Address): Promise<QuestResult> {
  const name = await reverseResolve(claimant).catch(() => null);
  return {
    index,
    type: "hold-basename",
    label: "Own a Basename",
    done: !!name,
    detail: name ? undefined : "This wallet has no Basename yet. Claim one at base.org/names, then come back.",
    proof: name ? { basename: name } : undefined,
  };
}

async function verifyHoldAsset(index: number, q: Quest, claimant: Address): Promise<QuestResult> {
  const symbol = await symbolFor(q.assetAddress);
  const base: QuestResult = { index, type: "hold-asset", label: label(q, symbol), done: false };
  if (!q.assetAddress) return { ...base, detail: "This step is misconfigured; ask the creator to fix it." };
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
 * "Bought at least $X of this stock recently." The app's own trade rows only say which
 * transactions to look at; the proof is the receipt — a successful transaction carrying an ERC-20
 * `Transfer` of that exact asset into the claimant's wallet.
 */
async function verifyBuyAsset(index: number, q: Quest, claimant: Address): Promise<QuestResult> {
  const symbol = await symbolFor(q.assetAddress);
  const base: QuestResult = { index, type: "buy-asset", label: label(q, symbol), done: false };
  if (!q.assetAddress) return { ...base, detail: "This step is misconfigured; ask the creator to fix it." };

  const withinDays = q.withinDays ?? DEFAULT_WITHIN_DAYS;
  const since = Date.now() - withinDays * 24 * 3600 * 1000;
  const trades = await getRepos().trades.listByOwner(claimant).catch(() => []);
  const candidates = trades
    .filter((t) => t.side === "buy" && t.assetAddress.toLowerCase() === q.assetAddress!.toLowerCase() && t.createdAt >= since && !!t.txHash)
    .slice(0, MAX_RECEIPTS_PER_CHECK);
  if (candidates.length === 0) {
    return { ...base, detail: `No ${symbol ?? "purchase"} found in this wallet in the last ${withinDays} days.` };
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
    return { ...base, detail: "We could not confirm that purchase onchain yet. If it just went through, wait for the confirmation and retry." };
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
    detail: done ? undefined : `Confirmed ${formatUsd(usd)} so far — this pool asks for ${formatUsd(minUsd)}.`,
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

/** A self-declared X step: done once the claimant has confirmed it for this pool. */
function readDeclared(index: number, q: Quest, attested: Attestations): QuestResult {
  const done = typeof attested[String(index)] === "number";
  return {
    index,
    type: q.type,
    label: label(q),
    done,
    selfDeclared: true,
    actionUrl: questActionUrl(q),
    detail: done ? undefined : "Open X, do it, and confirm here.",
    proof: done ? { declaredAt: attested[String(index)] } : undefined,
  };
}

/* --------------------------------- API ---------------------------------- */

/**
 * Runs every quest of a pool for one address. Never throws: a failed check reads as "not done".
 * `attested` carries the claimant's own confirmations for the self-declared steps.
 */
export async function verifyQuests(quests: Quest[], claimant: Address, attested: Attestations = {}): Promise<QuestResult[]> {
  return Promise.all(
    quests.map(async (q, index): Promise<QuestResult> => {
      try {
        if (isSelfDeclared(q.type)) return readDeclared(index, q, attested);
        switch (q.type) {
          case "sign-in":
            // Reaching this point already required a valid SIWE session for `claimant`.
            return { index, type: "sign-in", label: label(q), done: true };
          case "hold-basename":
            return await verifyHoldBasename(index, claimant);
          case "hold-asset":
            return await verifyHoldAsset(index, q, claimant);
          case "buy-asset":
            return await verifyBuyAsset(index, q, claimant);
          default:
            return { index, type: q.type, label: "Unknown requirement", done: false, detail: "This pool asks for something this version cannot check." };
        }
      } catch {
        return { index, type: q.type, label: label(q), done: false, detail: "We could not check this right now. Try again in a moment." };
      }
    }),
  );
}

/** Quest labels for a pool without running any check — used on the public pool card. */
export async function describeQuests(quests: Quest[]): Promise<QuestStatus[]> {
  return Promise.all(
    quests.map(async (q, index) => ({
      index,
      type: q.type,
      label: label(q, await symbolFor(q.assetAddress)),
      done: false,
      selfDeclared: isSelfDeclared(q.type) || undefined,
      actionUrl: questActionUrl(q),
    })),
  );
}

/** Strips the internal `proof` field so nothing but the checklist reaches the browser. */
export function toQuestStatus(r: QuestResult): QuestStatus {
  return { index: r.index, type: r.type, label: r.label, done: r.done, detail: r.detail, actionUrl: r.actionUrl, selfDeclared: r.selfDeclared };
}

/**
 * Merges the evidence for one claim row. Checked quests store under their type; self-declared
 * confirmations stay in `attested` so the roster can tell the two apart at a glance.
 */
export function questProof(results: QuestResult[], attested: Attestations = {}): Record<string, unknown> {
  const proof: Record<string, unknown> = {};
  for (const r of results) if (r.proof && !r.selfDeclared) proof[r.type] = r.proof;
  if (Object.keys(attested).length > 0) proof.attested = attested;
  return proof;
}

/** Human list of what a claim row proves, for the creator's roster. */
export function proofSummary(questProof: Record<string, unknown>, quests: Quest[]): Array<{ label: string; checked: boolean }> {
  const out: Array<{ label: string; checked: boolean }> = [];
  for (const key of Object.keys(questProof)) {
    if (key === "attested") continue;
    out.push({ label: key, checked: true });
  }
  for (const idx of Object.keys(readAttestations(questProof))) {
    const q = quests[Number(idx)];
    if (q) out.push({ label: shortDeclaredLabel(q.type), checked: false });
  }
  return out;
}

function shortDeclaredLabel(type: QuestType): string {
  switch (type) {
    case "follow-bstocks":
    case "follow-x":
      return "follow";
    case "repost-x":
      return "repost";
    case "like-x":
      return "like";
    default:
      return type;
  }
}

import { formatUnits, type Address, type Hash } from "viem";
import type { B20Asset } from "@/domain/asset";
import { isSelfDeclared, type Quest, type QuestStatus, type QuestType } from "@/domain/pool";
import { getRepos } from "@/db/repositories";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { getAssets } from "@/services/b20-asset-service";
import { reverseResolve } from "@/services/basename-service";
import { verifyTrade } from "@/services/tx-verify-service";
import { b20AssetAbi } from "@/lib/b20/abi";
import { BSTOCKS_X_HANDLE, xIntentUrl, xProfileUrl } from "@/content/social";
import { isHttpUrl, prettyHost } from "@/lib/url";
import { formatShares } from "@/lib/gift/format";
import { formatUsd } from "@/lib/format";
import { USDC_DECIMALS } from "@/config/chain";

/**
 * Quest verification for gift pools. Everything here runs on the server and gates a claim ticket;
 * the contract knows nothing about quests, so a new quest type never needs a new deployment.
 *
 * Two grades of quest, kept apart everywhere:
 *
 * - **Checked** — proven from the chain or a signature. App-side records (`trade_records`) are a
 *   lookup index, never evidence: every purchase they point at is re-read from its receipt, through
 *   the same cached, stored path the trade verifier uses, and counts only when USDC left the buyer.
 *   A stock arriving in a wallet is not a purchase; a transfer from a friend looks the same.
 * - **Self-declared** — X steps and link visits. Nobody can prove a follow, a repost, a like or a
 *   page view from outside, so the claimant confirms these about themselves and the app stores who
 *   declared what, with the timestamp. Nothing in the copy calls that "verified", because it is not.
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
    case "visit-url":
      return q.label?.trim() || (q.url ? `Visit ${prettyHost(q.url)}` : "Visit the link");
  }
}

/** Where a step sends the claimant to actually do it: the stock's buy panel, or a social link. */
export function questActionUrl(q: Quest): string | undefined {
  switch (q.type) {
    case "hold-asset":
    case "buy-asset":
      // Checked steps: send the claimant straight to the stock's buy panel, then re-verify on return.
      return q.assetAddress ? `/stocks/${q.assetAddress}?trade=buy` : undefined;
    case "follow-bstocks":
      return xProfileUrl(BSTOCKS_X_HANDLE);
    case "follow-x":
      return q.handle ? xProfileUrl(q.handle) : undefined;
    case "repost-x":
      return q.tweetUrl ? xIntentUrl("repost", q.tweetUrl) : undefined;
    case "like-x":
      return q.tweetUrl ? xIntentUrl("like", q.tweetUrl) : undefined;
    case "visit-url":
      // Never hand a non-http scheme to `window.open`, whatever landed in storage.
      return q.url && isHttpUrl(q.url) ? q.url : undefined;
    default:
      return undefined;
  }
}

async function assetFor(address?: Address): Promise<B20Asset | undefined> {
  if (!address) return undefined;
  const assets = await getAssets().catch(() => []);
  return assets.find((a) => a.canonicalId === address.toLowerCase());
}

async function symbolFor(asset?: Address): Promise<string | undefined> {
  return (await assetFor(asset))?.underlying;
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
  const asset = await assetFor(q.assetAddress);
  const symbol = asset?.underlying;
  const base: QuestResult = { index, type: "hold-asset", label: label(q, symbol), done: false, actionUrl: questActionUrl(q) };
  if (!q.assetAddress) return { ...base, detail: "This step is misconfigured; ask the creator to fix it." };
  const min = BigInt(q.minRawAmount ?? "1");
  const balance = await getServerPublicClient()
    .readContract({ address: q.assetAddress, abi: b20AssetAbi, functionName: "balanceOf", args: [claimant] })
    .catch(() => null);
  if (balance === null) return { ...base, detail: "We could not read your balance just now. Try again in a moment." };
  const done = balance >= min;
  // The minimum is stored raw; the claimant reads shares, so it is scaled by the stock's multiplier like every other amount.
  const minLabel = asset ? formatShares(min, asset) : formatUnits(min, 8);
  return {
    ...base,
    done,
    detail: done ? undefined : `You need at least ${minLabel} ${symbol ?? "of this stock"} in this wallet.`,
    proof: done ? { balance: balance.toString() } : undefined,
  };
}

/**
 * "Bought at least $X of this stock on BStocks recently." The app's own trade rows only say
 * which transactions to look at; the proof is the receipt, read by `verifyTrade` (cached, and
 * stored once mined, so a ticket request never re-asks the RPC for a hash already seen). A
 * purchase is the stock arriving AND USDC leaving this wallet in the same transaction: the stock
 * arriving alone is what a transfer from any other wallet looks like, and that is not a purchase.
 * The dollar figure is the USDC that actually settled, not today's price times the amount.
 */
async function verifyBuyAsset(index: number, q: Quest, claimant: Address): Promise<QuestResult> {
  const symbol = await symbolFor(q.assetAddress);
  const base: QuestResult = { index, type: "buy-asset", label: label(q, symbol), done: false, actionUrl: questActionUrl(q) };
  if (!q.assetAddress) return { ...base, detail: "This step is misconfigured; ask the creator to fix it." };

  const withinDays = q.withinDays ?? DEFAULT_WITHIN_DAYS;
  const since = Date.now() - withinDays * 24 * 3600 * 1000;
  const trades = await getRepos().trades.listByOwner(claimant).catch(() => []);
  const candidates = trades
    .filter((t) => t.side === "buy" && t.assetAddress.toLowerCase() === q.assetAddress!.toLowerCase() && t.createdAt >= since && !!t.txHash && t.status !== "failed")
    .slice(0, MAX_RECEIPTS_PER_CHECK);
  if (candidates.length === 0) {
    return { ...base, detail: `No ${symbol ?? "stock"} bought on BStocks from this wallet in the last ${withinDays} days.` };
  }

  let boughtRaw = 0n;
  let paidUsdc = 0n;
  let pending = false;
  const verifiedTxs: Hash[] = [];
  for (const t of candidates) {
    const v = await verifyTrade({ txHash: t.txHash!, owner: claimant, assetAddress: q.assetAddress, side: "buy" });
    if (!v.ok) {
      if (v.state === "pending") pending = true;
      continue;
    }
    // No USDC out of this wallet means a transfer in, a gift, or a buy paid some other way; none of those is this step.
    if (v.usdcAmount === null || v.usdcAmount <= 0n) continue;
    boughtRaw += v.assetAmount;
    paidUsdc += v.usdcAmount;
    verifiedTxs.push(t.txHash!);
  }
  if (verifiedTxs.length === 0) {
    return {
      ...base,
      detail: pending
        ? "We could not confirm that purchase onchain yet. If it just went through, wait for the confirmation and retry."
        : `Only ${symbol ?? "stock"} bought on BStocks and paid in USDC from this wallet counts; a transfer in does not.`,
    };
  }

  const usd = Number(formatUnits(paidUsdc, USDC_DECIMALS));
  const minUsd = q.minUsd ?? 0;
  const done = minUsd <= 0 || usd + 1e-9 >= minUsd;
  return {
    ...base,
    done,
    detail: done ? undefined : `${formatUsd(usd)} bought on BStocks so far; this pool asks for ${formatUsd(minUsd)}.`,
    proof: done ? { txs: verifiedTxs, rawAmount: boughtRaw.toString(), usd } : undefined,
  };
}

/** A self-declared X step: done once the claimant has confirmed it for this pool. */
function readDeclared(index: number, q: Quest, attested: Attestations): QuestResult {
  const done = typeof attested[String(index)] === "number";
  const actionUrl = questActionUrl(q);
  return {
    index,
    type: q.type,
    label: label(q),
    done,
    selfDeclared: true,
    actionUrl,
    // A link step always names where it goes; a creator's label alone could call any page anything.
    detail: done
      ? undefined
      : actionUrl
        ? q.type === "visit-url"
          ? `Opens ${prettyHost(actionUrl)}. Then confirm here.`
          : "Open X, do it, then confirm here."
        : "This step has no destination; ask the creator to fix it.",
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
    case "visit-url":
      return "visit";
    default:
      return type;
  }
}

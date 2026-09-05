import type { Address, Hash } from "viem";
import type { ActivityItem, ActivityLeg } from "@/domain/activity";
import type { GiftRecord } from "@/domain/gift";
import type { PoolClaim, PoolRecord } from "@/domain/pool";
import type { PortfolioExecution } from "@/domain/portfolio";
import type { EarnActionRecord, TradeRecord } from "@/db/repositories";
import type { ReceiptState } from "@/services/receipt-service";
import { USDC_DECIMALS } from "@/config/chain";

/**
 * The activity timeline, assembled from records the app wrote and transfers the chain shows.
 *
 * Pure: everything it needs is handed in, so the rules below can be tested without a database or
 * an RPC. The one rule that matters most — **one transaction, one row** — is what stops a basket
 * from appearing twice (once as the basket, once per leg) and a gift bought for someone from
 * appearing as both a purchase and a send.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface TimelineAsset {
  canonicalId: string;
  address: Address;
  symbol: string;
  decimals: number;
}

export interface TimelineTransfer {
  txHash: Hash;
  blockNumber: bigint;
  asset: Address;
  from: Address;
  to: Address;
  value: bigint;
  /** Unix seconds, when the block time was read. */
  timestamp?: number;
}

export interface TimelineInput {
  owner: Address;
  assets: TimelineAsset[];
  trades: TradeRecord[];
  gifts: GiftRecord[];
  executions: PortfolioExecution[];
  earnActions: EarnActionRecord[];
  /** Pools this wallet funded. */
  pools: PoolRecord[];
  /** Shares this wallet took, with the pools they came from. */
  poolClaims: Array<{ claim: PoolClaim; pool: PoolRecord | null }>;
  transfers: TimelineTransfer[];
  /** Receipt states by lowercase hash; a hash with no entry is treated as pending. */
  receipts: Map<string, ReceiptState>;
}

/**
 * What became of a record the app wrote down, resolved to one of three answers.
 *
 * Seeing the token transfer is proof on its own — that is the chain saying it happened. Failing
 * that, the receipt decides: mined and succeeded, mined and reverted, or not mined yet. Only the
 * last is pending, and it clears within a block or two.
 */
export function settleRecord(sawTransfer: boolean, receipt: ReceiptState | undefined): { verified: boolean; failed: boolean; blockNumber?: number } {
  if (sawTransfer) return { verified: true, failed: false };
  if (!receipt) return { verified: false, failed: false };
  return { verified: receipt.status === "success", failed: receipt.status === "reverted", blockNumber: receipt.blockNumber };
}

const lower = (s: string | undefined | null) => (s ?? "").toLowerCase();
const isHash = (h: string | undefined | null): h is Hash => !!h && /^0x[0-9a-fA-F]{64}$/.test(h);

/** A record filed while its receipt was pending is given this long before the timeline stops showing it. */
export const PENDING_SHOWN_MS = 24 * 3600_000;

/**
 * Whether a record is the wallet's own, as far as the timeline can tell. The server marks a
 * record it matched to the chain with `verifiedAt`; a record the chain contradicted carries a
 * `verifyNote` and a failed status and is not shown at all — it was never this wallet's
 * transaction. Seeing the transfer in the wallet's own index is proof of the same kind.
 */
function disowned(r: { status?: string; verifyNote?: string }): boolean {
  return r.status === "failed" && !!r.verifyNote && r.verifyNote !== "reverted";
}

export function buildTimeline(input: TimelineInput): ActivityItem[] {
  const owner = input.owner;
  const me = lower(owner);
  const byAddr = new Map(input.assets.map((a) => [a.canonicalId, a]));
  const assetOf = (address: string) => byAddr.get(lower(address));

  const onchainByTx = new Map<string, TimelineTransfer[]>();
  for (const t of input.transfers) {
    const k = lower(t.txHash);
    onchainByTx.set(k, [...(onchainByTx.get(k) ?? []), t]);
  }
  const settle = (txHash: string | undefined) => {
    const k = lower(txHash);
    return settleRecord(onchainByTx.has(k), input.receipts.get(k));
  };
  const receiptOf = (txHash: string | undefined) => input.receipts.get(lower(txHash));
  const timeOf = (txHash: string | undefined, fallbackMs: number) => {
    const r = receiptOf(txHash);
    return r?.blockTime ?? Math.floor(fallbackMs / 1000);
  };
  const blockOf = (txHash: string | undefined) => {
    const chain = onchainByTx.get(lower(txHash));
    return chain?.[0] ? Number(chain[0].blockNumber) : receiptOf(txHash)?.blockNumber;
  };

  const items: ActivityItem[] = [];
  /** Every hash a row already stands for; the raw transfer scan must not add it again. */
  const consumed = new Set<string>();

  /* ------------------------------ executions ------------------------------ */
  // A basket is one row. Its legs are trade records too (the executor writes both), so every
  // hash the basket touched is claimed here and the matching trade rows are dropped below.
  const legHashes = new Set<string>();
  for (const e of input.executions) {
    const submitted = e.steps.filter((s) => isHash(s.txHash));
    if (submitted.length === 0) continue;
    const legs: ActivityLeg[] = e.steps.map((s) => {
      const asset = assetOf(s.assetAddress);
      let status: ActivityLeg["status"] = "pending";
      if (isHash(s.txHash)) {
        const st = settle(s.txHash);
        status = st.verified ? "confirmed" : st.failed ? "failed" : "pending";
        legHashes.add(lower(s.txHash));
        consumed.add(lower(s.txHash));
      } else if (s.status === "failed") status = "failed";
      return { assetAddress: s.assetAddress, symbol: asset?.symbol ?? s.symbol, amountUsd: s.targetUsd, txHash: s.txHash, status, provider: s.provider, decimals: asset?.decimals };
    });
    const confirmed = legs.filter((l) => l.status === "confirmed");
    const pending = legs.filter((l) => l.status === "pending" && l.txHash);
    const failedAll = legs.every((l) => l.status === "failed");
    const first = confirmed[0]?.txHash ?? submitted[0]!.txHash!;
    items.push({
      id: `exec:${e.id}`,
      owner,
      type: "portfolio-build",
      txHash: first,
      blockNumber: blockOf(first),
      timestamp: timeOf(first, e.createdAt),
      amountUsd: confirmed.reduce((s, l) => s + (l.amountUsd ?? 0), 0),
      source: "app",
      verified: confirmed.length > 0 && pending.length === 0,
      legs,
      metadata: { status: e.status, completed: confirmed.length, total: legs.length, plannedUsd: e.totalUsd, ...(failedAll ? { failed: true } : {}) },
    });
  }

  /* -------------------------------- gifts -------------------------------- */
  // Only gifts that reached the chain; drafts are review screens that were closed, and a gift the
  // chain contradicted was never this wallet's.
  const gifts = input.gifts.filter((g) => isHash(g.txHash) && !disowned(g) && (g.verifiedAt !== undefined || g.status === "failed" || onchainByTx.has(lower(g.txHash)) || Date.now() - g.createdAt <= PENDING_SHOWN_MS));
  const giftProven = (g: GiftRecord, hash: string) => g.verifiedAt !== undefined || onchainByTx.has(lower(hash));
  const giftTx = new Set(gifts.filter((g) => g.kind !== "claim-link" && lower(g.sender) === me).map((g) => lower(g.txHash)));

  /* -------------------------------- trades -------------------------------- */
  // Trade rows sharing a hash are legs of one transaction (an AutoInvest run, a batched basket)
  // and become one row; a row whose hash a basket or a gift already tells the story of is dropped.
  const tradeUsdByTx = new Map<string, { usd: number | null; provider: string }>();
  const groups = new Map<string, TradeRecord[]>();
  const now = Date.now();
  for (const t of [...input.trades].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!isHash(t.txHash) || disowned(t)) continue;
    const k = lower(t.txHash);
    // Unproven and old: the sweep will have written it off; showing it as pending forever misleads.
    if (!t.verifiedAt && !onchainByTx.has(k) && t.status !== "failed" && now - t.createdAt > PENDING_SHOWN_MS) continue;
    if (!tradeUsdByTx.has(k)) tradeUsdByTx.set(k, { usd: t.usdValue, provider: t.provider });
    if (legHashes.has(k) || giftTx.has(k)) continue;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const [k, rows] of groups) {
    // The same purchase posted twice (a retried request) is one purchase.
    const seen = new Set<string>();
    const unique = rows.filter((t) => {
      const key = `${lower(t.assetAddress)}:${t.side}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    consumed.add(k);
    // The receipt says mined; the server's match (or the wallet's own transfer index) says it is this wallet's.
    const proven = onchainByTx.has(k) || unique.some((t) => t.verifiedAt !== undefined);
    const raw = settle(k);
    const st = { verified: raw.verified && proven, failed: raw.failed || unique.every((t) => t.status === "failed"), blockNumber: raw.blockNumber };
    const blockNumber = blockOf(k);
    if (unique.length === 1) {
      const t = unique[0]!;
      const asset = assetOf(t.assetAddress);
      items.push({
        id: `trade:${t.id}`,
        owner,
        type: t.side,
        txHash: t.txHash!,
        blockNumber,
        timestamp: timeOf(k, t.createdAt),
        assetAddress: t.assetAddress,
        symbol: asset?.symbol,
        amountUsd: t.usdValue ?? undefined,
        rawAmount: t.side === "buy" ? t.buyAmount : t.sellAmount,
        decimals: asset?.decimals,
        counterparty: t.recipient,
        provider: t.provider,
        source: "app",
        verified: st.verified,
        metadata: st.failed ? { failed: true } : undefined,
      });
      continue;
    }
    const legs: ActivityLeg[] = unique.map((t) => {
      const asset = assetOf(t.assetAddress);
      return { assetAddress: t.assetAddress, symbol: asset?.symbol ?? t.assetAddress.slice(0, 8), amountUsd: t.usdValue ?? undefined, rawAmount: t.side === "buy" ? t.buyAmount : t.sellAmount, decimals: asset?.decimals, txHash: t.txHash, status: st.verified ? "confirmed" : st.failed ? "failed" : "pending", provider: t.provider };
    });
    const auto = unique.every((t) => t.provider === "auto-invest");
    items.push({
      id: `${auto ? "auto" : "batch"}:${k}`,
      owner,
      type: auto ? "auto-invest" : "portfolio-build",
      txHash: unique[0]!.txHash!,
      blockNumber,
      timestamp: timeOf(k, unique[0]!.createdAt),
      amountUsd: legs.reduce((s, l) => s + (l.amountUsd ?? 0), 0),
      provider: auto ? "auto-invest" : undefined,
      source: "app",
      verified: st.verified,
      legs,
      metadata: { completed: st.verified ? legs.length : 0, total: legs.length, ...(st.failed ? { failed: true } : {}) },
    });
  }

  /* ---------------------------- gifts, as rows ---------------------------- */
  // Claim links funded together share one deposit transaction; they are one row with a count.
  const linkGroups = new Map<string, GiftRecord[]>();
  for (const g of gifts) {
    if (g.kind !== "claim-link" || lower(g.sender) !== me) continue;
    const k = lower(g.txHash);
    linkGroups.set(k, [...(linkGroups.get(k) ?? []), g]);
  }
  for (const [k, group] of linkGroups) {
    const first = [...group].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    const asset = assetOf(first.assetAddress);
    const raw = settle(k);
    const st = { ...raw, verified: raw.verified && group.some((g) => giftProven(g, k)) };
    consumed.add(k);
    for (const g of group) if (isHash(g.claimTx)) consumed.add(lower(g.claimTx));
    const claimed = group.filter((g) => g.status === "claimed");
    const reclaimed = group.filter((g) => g.status === "reclaimed");
    const total = group.reduce((s, g) => s + BigInt(g.rawAmount), 0n);
    const single = group.length === 1 ? first : null;
    items.push({
      id: `gift:${k}`,
      owner,
      type: "send",
      txHash: first.txHash!,
      blockNumber: blockOf(k),
      timestamp: timeOf(k, first.createdAt),
      assetAddress: first.assetAddress,
      symbol: asset?.symbol,
      rawAmount: total.toString(),
      decimals: asset?.decimals,
      counterparty: single && single.status === "claimed" && lower(single.recipient) !== lower(ZERO_ADDRESS) ? single.recipient : undefined,
      source: "app",
      verified: st.verified,
      count: group.length,
      metadata: {
        kind: "claim-link",
        giftId: single?.id ?? null,
        giftIds: group.map((g) => g.id),
        message: single?.message ?? null,
        claimed: claimed.length,
        reclaimed: reclaimed.length,
        status: single ? single.status : group.length === claimed.length ? "claimed" : group.length === reclaimed.length ? "reclaimed" : "submitted",
        ...(single?.expiresAt ? { expiresAt: single.expiresAt } : {}),
        ...(st.failed ? { failed: true } : {}),
      },
    });
  }
  for (const g of gifts) {
    const isSender = lower(g.sender) === me;
    if (g.kind === "claim-link" && isSender) continue;
    const asset = assetOf(g.assetAddress);
    if (g.kind === "claim-link") {
      // The recipient's copy: what they claimed, on the claim transaction.
      if (lower(g.recipient) !== me || g.status !== "claimed") continue;
      const hash = isHash(g.claimTx) ? g.claimTx : g.txHash!;
      const k = lower(hash);
      consumed.add(k);
      consumed.add(lower(g.txHash));
      const raw = settle(k);
      const st = { ...raw, verified: raw.verified && giftProven(g, k) };
      items.push({
        id: `gift:${g.id}:claim`,
        owner,
        type: "receive",
        txHash: hash,
        blockNumber: blockOf(k),
        timestamp: timeOf(k, g.createdAt),
        assetAddress: g.assetAddress,
        symbol: asset?.symbol,
        rawAmount: g.rawAmount,
        decimals: asset?.decimals,
        counterparty: g.sender,
        source: "app",
        verified: st.verified,
        metadata: { kind: "claim-link", giftId: g.id, message: g.message ?? null, status: g.status, ...(st.failed ? { failed: true } : {}) },
      });
      continue;
    }
    const k = lower(g.txHash);
    consumed.add(k);
    const raw = settle(k);
    const st = { ...raw, verified: raw.verified && giftProven(g, k) };
    const trade = tradeUsdByTx.get(k);
    items.push({
      id: `gift:${g.id}`,
      owner,
      type: isSender ? "send" : "receive",
      txHash: g.txHash!,
      blockNumber: blockOf(k),
      timestamp: timeOf(k, g.createdAt),
      assetAddress: g.assetAddress,
      symbol: asset?.symbol,
      amountUsd: trade?.usd ?? undefined,
      rawAmount: g.rawAmount,
      decimals: asset?.decimals,
      counterparty: isSender ? g.recipient : g.sender,
      counterpartyBasename: isSender ? g.recipientBasename : undefined,
      provider: trade?.provider,
      source: "app",
      verified: st.verified,
      metadata: { kind: g.kind, giftId: g.id, message: g.message ?? null, status: g.status, ...(st.failed ? { failed: true } : {}) },
    });
  }

  /* --------------------------------- earn --------------------------------- */
  // Lending venues move USDC; liquidity positions move stock and USDC. Both are USDC-denominated
  // records (the USDC leg, plus a USD figure), verified by receipt.
  for (const a of input.earnActions) {
    if (!isHash(a.txHash)) continue;
    // A note without a verification is the sweep saying the receipt contradicted the record.
    if (a.verifyNote && !a.verifiedAt) continue;
    const k = lower(a.txHash);
    consumed.add(k);
    const r = receiptOf(k);
    const lp = isLpProvider(a.provider);
    items.push({
      id: `earn:${a.id}`,
      owner,
      type: a.action === "collect" ? "earn-collect" : a.action === "deposit" ? (lp ? "earn-liquidity" : "earn-supply") : "earn-withdraw",
      txHash: a.txHash,
      blockNumber: r?.blockNumber,
      timestamp: timeOf(k, a.createdAt),
      symbol: "USDC",
      amountUsd: a.usdValue ?? undefined,
      rawAmount: a.amount,
      decimals: USDC_DECIMALS,
      provider: a.provider,
      source: "app",
      verified: r?.status === "success" && a.verifiedAt !== undefined,
      metadata: { opportunityId: a.opportunityId, title: EARN_PROVIDER_LABEL[a.provider] ?? a.provider, lp, ...(r?.status === "reverted" ? { failed: true } : {}) },
    });
  }

  /* --------------------------------- pools -------------------------------- */
  for (const p of input.pools) {
    if (!isHash(p.txHash) || p.status === "draft" || disowned(p)) continue;
    const k = lower(p.txHash);
    consumed.add(k);
    const raw = settle(k);
    const st = { ...raw, verified: raw.verified && (p.verifiedAt !== undefined || onchainByTx.has(k)) };
    const legs = poolLegs(p, assetOf);
    const single = legs.length === 1 ? legs[0] : undefined;
    items.push({
      id: `pool:${p.id}`,
      owner,
      type: "pool-create",
      txHash: p.txHash,
      blockNumber: blockOf(k),
      timestamp: timeOf(k, p.createdAt),
      assetAddress: single?.assetAddress,
      symbol: single?.symbol,
      rawAmount: single ? (BigInt(single.rawAmount ?? "0") * BigInt(p.slots)).toString() : undefined,
      decimals: single?.decimals,
      source: "app",
      verified: st.verified,
      legs: legs.map((l) => ({ ...l, status: st.verified ? "confirmed" : st.failed ? "failed" : "pending" })),
      metadata: { poolId: p.id, slots: p.slots, title: p.title ?? null, status: p.status, gateMode: p.gateMode, ...(st.failed ? { failed: true } : {}) },
    });
  }
  for (const { claim, pool } of input.poolClaims) {
    if (!isHash(claim.txHash) || claim.status === "issued") continue;
    const k = lower(claim.txHash);
    consumed.add(k);
    const raw = settle(k);
    // Only a row matched to a `PoolClaimed` log is proof; a page-reported one waits for the sweep.
    const st = { ...raw, verified: claim.status === "reconciled" || (raw.verified && onchainByTx.has(k)) };
    const legs = pool ? poolLegs(pool, assetOf) : [];
    const single = legs.length === 1 ? legs[0] : undefined;
    items.push({
      id: `pool-claim:${claim.poolId}`,
      owner,
      type: "pool-claim",
      txHash: claim.txHash,
      blockNumber: blockOf(k) ?? claim.blockNumber,
      timestamp: timeOf(k, claim.createdAt),
      assetAddress: single?.assetAddress,
      symbol: single?.symbol,
      rawAmount: single?.rawAmount,
      decimals: single?.decimals,
      counterparty: pool?.creator,
      source: "app",
      verified: st.verified,
      legs: legs.map((l) => ({ ...l, status: st.verified ? "confirmed" : st.failed ? "failed" : "pending" })),
      metadata: { poolId: claim.poolId, title: pool?.title ?? null, status: claim.status, ...(st.failed ? { failed: true } : {}) },
    });
  }

  /* ------------------------- onchain-only transfers ----------------------- */
  // Received from others, or trades made elsewhere: whatever no record above explains.
  for (const [tx, list] of onchainByTx) {
    if (consumed.has(tx)) continue;
    for (const t of list) {
      const asset = assetOf(t.asset);
      const isOut = lower(t.from) === me;
      items.push({
        id: `chain:${t.txHash}:${t.asset}:${isOut ? "out" : "in"}`,
        owner,
        type: isOut ? "send" : "receive",
        txHash: t.txHash,
        blockNumber: Number(t.blockNumber),
        timestamp: t.timestamp,
        assetAddress: t.asset,
        symbol: asset?.symbol,
        rawAmount: t.value.toString(),
        decimals: asset?.decimals,
        counterparty: isOut ? t.to : t.from,
        source: "onchain",
        verified: true,
      });
    }
  }

  items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || (b.blockNumber ?? 0) - (a.blockNumber ?? 0));
  return items;
}

const EARN_PROVIDER_LABEL: Record<string, string> = { morpho: "Morpho", aave: "Aave V3", compound: "Compound v3", aerodrome: "Aerodrome Slipstream", uniswap: "Uniswap v3" };

/** Concentrated-liquidity venues: their records carry stock as well as USDC. */
export function isLpProvider(provider: string): boolean {
  return provider === "uniswap" || provider === "aerodrome";
}

function poolLegs(p: PoolRecord, assetOf: (a: string) => TimelineAsset | undefined): Array<Omit<ActivityLeg, "status">> {
  return p.legs.map((l) => {
    const asset = assetOf(l.token);
    return { assetAddress: l.token, symbol: asset?.symbol ?? l.token.slice(0, 8), rawAmount: l.amountPerClaim, decimals: asset?.decimals };
  });
}

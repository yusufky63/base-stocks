import { formatUnits, type Address, type Hash } from "viem";
import type { ActivityItem } from "@/domain/activity";
import { b20AssetAbi } from "@/lib/b20/abi";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getRepos } from "@/db/repositories";
import { getAssets } from "./b20-asset-service";
import { reverseResolve } from "./basename-service";
import { USDC_DECIMALS } from "@/config/chain";

/**
 * Unified activity timeline (spec §33).
 * Priority: app execution records → receipts → onchain events. App records are marked
 * `verified` only when a matching onchain Transfer for the same tx hash exists.
 */
const LOOKBACK_BLOCKS = 120_000n;
const CHUNK = 10_000n;

interface OnchainTransfer {
  txHash: Hash;
  blockNumber: bigint;
  asset: Address;
  from: Address;
  to: Address;
  value: bigint;
}

interface ScanState {
  upTo: bigint;
  items: OnchainTransfer[];
  at: number;
}
/** Per-owner scan position so a refresh only reads the blocks mined since the last scan (bounded owners). */
const SCAN_STATE = new Map<string, ScanState>();
const SCAN_STATE_MAX = 300;

async function scanTransfers(owner: Address, assets: Address[]): Promise<OnchainTransfer[]> {
  const key = owner.toLowerCase();
  return cached(`activity:scan:${key}`, { ttlMs: 90_000, staleMs: 10 * 60_000 }, async () => {
    const client = getServerPublicClient();
    const latest = await client.getBlockNumber();
    const floor = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
    const prev = SCAN_STATE.get(key);
    const incremental = !!prev && prev.upTo >= floor;
    const from = incremental ? prev.upTo + 1n : floor;
    const out: OnchainTransfer[] = incremental ? prev.items.filter((t) => t.blockNumber >= floor) : [];
    let upTo = incremental ? prev.upTo : floor - 1n;
    const transferEvent = b20AssetAbi.find((x) => x.type === "event" && x.name === "Transfer")!;
    for (let start = from; start <= latest; start += CHUNK + 1n) {
      const end = start + CHUNK > latest ? latest : start + CHUNK;
      try {
        const [sent, received] = await Promise.all([
          client.getLogs({ address: assets, event: transferEvent as typeof b20AssetAbi[number] & { type: "event" }, args: { from: owner }, fromBlock: start, toBlock: end }),
          client.getLogs({ address: assets, event: transferEvent as typeof b20AssetAbi[number] & { type: "event" }, args: { to: owner }, fromBlock: start, toBlock: end }),
        ]);
        for (const log of [...sent, ...received]) {
          const args = log.args as { from?: Address; to?: Address; value?: bigint };
          if (!args.from || !args.to || args.value === undefined || !log.transactionHash || log.blockNumber === null) continue;
          out.push({ txHash: log.transactionHash, blockNumber: log.blockNumber, asset: log.address as Address, from: args.from, to: args.to, value: args.value });
        }
        upTo = end;
      } catch (err) {
        metrics.count("activity.scan", false, err instanceof Error ? err.message : String(err));
        break; // public RPC range limit: keep what we have and resume from `upTo` next time
      }
    }
    // de-dupe (a self-transfer appears twice; incremental merges could repeat a boundary block)
    const seen = new Set<string>();
    const deduped = out.filter((t) => {
      const k = `${t.txHash}:${t.asset}:${t.from}:${t.to}:${t.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (SCAN_STATE.size >= SCAN_STATE_MAX) {
      const oldest = [...SCAN_STATE.entries()].sort((x, y) => x[1].at - y[1].at)[0];
      if (oldest) SCAN_STATE.delete(oldest[0]);
    }
    SCAN_STATE.set(key, { upTo, items: deduped, at: Date.now() });
    return deduped;
  });
}

const EARN_PROVIDER_LABEL: Record<string, string> = { morpho: "Morpho", aave: "Aave V3", compound: "Compound v3", aerodrome: "Aerodrome", uniswap: "Uniswap" };

/** Receipt lookup for app records that do not move B20 tokens (Earn). Cached: a mined receipt never changes. */
async function receiptStatus(hash: Hash): Promise<{ status: "success" | "reverted" | "pending"; blockNumber?: number }> {
  return cached(`activity:receipt:${hash.toLowerCase()}`, { ttlMs: 60 * 60_000, staleMs: 24 * 60 * 60_000 }, async () => {
    try {
      const r = await getServerPublicClient().getTransactionReceipt({ hash });
      return { status: r.status === "success" ? ("success" as const) : ("reverted" as const), blockNumber: Number(r.blockNumber) };
    } catch {
      // Not mined yet (or unknown to this RPC): do not cache for long by throwing → caller treats as pending.
      throw new Error("pending");
    }
  }).catch(() => ({ status: "pending" as const }));
}

export interface ReceiptState {
  status: "success" | "reverted" | "pending";
  blockNumber?: number;
}

/**
 * What became of a record the app wrote down, resolved to one of three answers.
 *
 * Seeing the token transfer is proof on its own — that is the chain saying it happened. Failing
 * that, the receipt decides: mined and succeeded, mined and reverted, or not mined yet. Only the
 * last is pending, and it clears within a block or two.
 *
 * This used to be a single boolean off the transfer scan, and the scan only reaches back a couple
 * of days. Anything older stayed unverified for good, so a trade that settled last week still read
 * "pending verification" — a state that looked like a warning and had no way out.
 */
export function settleRecord(sawTransfer: boolean, receipt: ReceiptState | undefined): { verified: boolean; failed: boolean; blockNumber?: number } {
  if (sawTransfer) return { verified: true, failed: false };
  if (!receipt) return { verified: false, failed: false };
  return { verified: receipt.status === "success", failed: receipt.status === "reverted", blockNumber: receipt.blockNumber };
}

export async function getActivity(owner: Address): Promise<ActivityItem[]> {
  const repos = getRepos();
  const assets = await getAssets();
  const byAddr = new Map(assets.map((a) => [a.canonicalId, a]));
  const [trades, gifts, executions, earnActions, transfers] = await Promise.all([
    repos.trades.listByOwner(owner),
    repos.gifts.listByOwner(owner),
    repos.executions.listByOwner(owner),
    repos.earnActions.listByOwner(owner),
    scanTransfers(owner, assets.map((a) => a.address)).catch(() => [] as OnchainTransfer[]),
  ]);
  const onchainByTx = new Map<string, OnchainTransfer[]>();
  for (const t of transfers) {
    const k = t.txHash.toLowerCase();
    onchainByTx.set(k, [...(onchainByTx.get(k) ?? []), t]);
  }
  /**
   * What actually happened to an app record, decided rather than left open.
   *
   * The chain scan only reaches back `LOOKBACK_BLOCKS` — a couple of days on Base — so a trade
   * older than that was never going to be matched by it, and "pending verification" was a state
   * nothing could ever leave. The receipt settles it at any age: mined and succeeded, mined and
   * reverted, or genuinely not mined yet. Only the last of those is pending.
   */
  const unmatched = [...trades, ...gifts]
    .map((r) => r.txHash)
    .concat(executions.flatMap((e) => e.steps.map((st) => st.txHash)))
    .filter((h): h is Hash => Boolean(h) && h !== "0x" && !onchainByTx.has(String(h).toLowerCase()))
    .map((h) => h.toLowerCase() as Hash);
  const uniqueUnmatched = [...new Set(unmatched)].slice(0, 40);
  const settledByTx = new Map<string, Awaited<ReturnType<typeof receiptStatus>>>();
  await Promise.all(uniqueUnmatched.map(async (h) => settledByTx.set(h, await receiptStatus(h))));

  const settle = (txHash: string | null | undefined, sawTransfer: boolean) => settleRecord(sawTransfer, txHash ? settledByTx.get(txHash.toLowerCase()) : undefined);

  const items: ActivityItem[] = [];
  const consumedTx = new Set<string>();

  // Only things that were actually submitted to the chain belong in the timeline.
  for (const t of trades) {
    if (!t.txHash) continue;
    const asset = byAddr.get(t.assetAddress.toLowerCase());
    const chain = t.txHash ? onchainByTx.get(t.txHash.toLowerCase()) : undefined;
    const tradeState = settle(t.txHash, !!chain);
    if (t.txHash) consumedTx.add(t.txHash.toLowerCase());
    items.push({
      id: `trade:${t.id}`,
      owner,
      type: t.side,
      txHash: (t.txHash ?? "0x") as Hash,
      blockNumber: chain?.[0] ? Number(chain[0].blockNumber) : tradeState.blockNumber,
      timestamp: Math.floor(t.createdAt / 1000),
      assetAddress: t.assetAddress,
      symbol: asset?.symbol,
      amountUsd: t.usdValue ?? undefined,
      rawAmount: t.side === "buy" ? t.buyAmount : t.sellAmount,
      decimals: asset?.decimals,
      counterparty: t.recipient,
      provider: t.provider,
      source: "app",
      verified: tradeState.verified,
      metadata: tradeState.failed ? { failed: true } : undefined,
    });
  }
  for (const g of gifts) {
    if (!g.txHash) continue;
    const asset = byAddr.get(g.assetAddress.toLowerCase());
    const chain = g.txHash ? onchainByTx.get(g.txHash.toLowerCase()) : undefined;
    if (g.txHash) consumedTx.add(g.txHash.toLowerCase());
    const giftState = settle(g.txHash, !!chain);
    const isSender = g.sender.toLowerCase() === owner.toLowerCase();
    items.push({
      id: `gift:${g.id}`,
      owner,
      type: isSender ? "send" : "receive",
      txHash: (g.txHash ?? "0x") as Hash,
      blockNumber: chain?.[0] ? Number(chain[0].blockNumber) : giftState.blockNumber,
      timestamp: Math.floor(g.createdAt / 1000),
      assetAddress: g.assetAddress,
      symbol: asset?.symbol,
      rawAmount: g.rawAmount,
      decimals: asset?.decimals,
      counterparty: isSender ? g.recipient : g.sender,
      counterpartyBasename: isSender ? g.recipientBasename : undefined,
      source: "app",
      verified: giftState.verified,
      metadata: { message: g.message ?? null, kind: g.kind, giftId: g.id, ...(giftState.failed ? { failed: true } : {}) },
    });
  }
  for (const e of executions) {
    const confirmed = e.steps.filter((s) => s.status === "confirmed");
    const submitted = e.steps.filter((s) => s.txHash);
    if (submitted.length === 0) continue;
    for (const s of e.steps) if (s.txHash) consumedTx.add(s.txHash.toLowerCase());
    items.push({
      id: `exec:${e.id}`,
      owner,
      type: "portfolio-build",
      txHash: (confirmed[0]?.txHash ?? "0x") as Hash,
      timestamp: Math.floor(e.createdAt / 1000),
      amountUsd: e.totalUsd,
      source: "app",
      verified: confirmed.length > 0 && confirmed.every((st) => st.txHash && settle(st.txHash, onchainByTx.has(st.txHash.toLowerCase())).verified),
      metadata: { status: e.status, completed: confirmed.length, total: e.steps.length, ...(confirmed.some((st) => st.txHash && settle(st.txHash, false).failed) ? { failed: true } : {}) },
    });
  }
  // Earn deposits / withdrawals: USDC moves, not B20 transfers, so they are verified by receipt.
  const receipts = await Promise.all(earnActions.filter((a) => a.txHash).slice(0, 30).map((a) => receiptStatus(a.txHash!)));
  earnActions
    .filter((a) => a.txHash)
    .slice(0, 30)
    .forEach((a, i) => {
      const r = receipts[i]!;
      consumedTx.add(a.txHash!.toLowerCase());
      items.push({
        id: `earn:${a.id}`,
        owner,
        type: a.action === "deposit" ? "earn-supply" : "earn-withdraw",
        txHash: a.txHash!,
        blockNumber: r.blockNumber,
        timestamp: Math.floor(a.createdAt / 1000),
        amountUsd: a.usdValue ?? undefined,
        rawAmount: a.amount,
        decimals: USDC_DECIMALS,
        provider: a.provider,
        source: "app",
        verified: r.status === "success",
        metadata: { opportunityId: a.opportunityId, title: EARN_PROVIDER_LABEL[a.provider] ?? a.provider, failed: r.status === "reverted" },
      });
    });

  // Onchain-only transfers (received from others, or trades made elsewhere)
  for (const [tx, list] of onchainByTx) {
    if (consumedTx.has(tx)) continue;
    for (const t of list) {
      const asset = byAddr.get(t.asset.toLowerCase());
      const isOut = t.from.toLowerCase() === owner.toLowerCase();
      items.push({
        id: `chain:${t.txHash}:${t.asset}:${isOut ? "out" : "in"}`,
        owner,
        type: isOut ? "send" : "receive",
        txHash: t.txHash,
        blockNumber: Number(t.blockNumber),
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

  // Resolve Basenames for counterparties (best effort, cached).
  const counterparties = Array.from(new Set(items.map((i) => i.counterparty).filter((x): x is Address => !!x))).slice(0, 25);
  const names = await Promise.all(counterparties.map((a) => reverseResolve(a).catch(() => null)));
  const nameMap = new Map(counterparties.map((a, i) => [a.toLowerCase(), names[i]]));
  for (const i of items) if (i.counterparty && !i.counterpartyBasename) i.counterpartyBasename = nameMap.get(i.counterparty.toLowerCase()) ?? undefined;
  // BStocks handles for counterparties with a public profile here ("this member sent you a gift").
  const profiles = await Promise.all(counterparties.map((a) => repos.profiles.get(a).catch(() => null)));
  const handleMap = new Map(counterparties.map((a, i) => [a.toLowerCase(), profiles[i]?.isPublic ? profiles[i]?.handle : undefined]));
  for (const i of items) if (i.counterparty && !i.counterpartyHandle) i.counterpartyHandle = handleMap.get(i.counterparty.toLowerCase()) ?? undefined;

  items.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || (b.blockNumber ?? 0) - (a.blockNumber ?? 0));
  return items;
}

export function usdcAmount(raw: string): number {
  return Number(formatUnits(BigInt(raw), USDC_DECIMALS));
}

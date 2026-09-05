import { formatUnits, type Address, type Hash } from "viem";
import type { AssetStat, DailyStat, DayRollup, LedgerEntry, LedgerKind, PlatformStats, StatsCounter, StatsSummary, StatsWindowKey } from "@/domain/stats";
import type { GiftRecord } from "@/domain/gift";
import type { PoolClaim, PoolRecord } from "@/domain/pool";
import type { PortfolioExecution } from "@/domain/portfolio";
import type { EarnActionRecord, TradeRecord } from "@/db/repositories";
import type { AutomationRule, CommunityBasket, Profile } from "@/domain/community";
import type { ReceiptState } from "@/services/receipt-service";

/**
 * Platform statistics, computed from the app's own records and the chain's receipts. Pure: hand it
 * the records and it answers; the service around it decides what to load.
 *
 * Two rules everything here follows:
 *
 * 1. **A record counts once the chain agrees.** Every event carries the state of its receipt, and
 *    only `verified` events reach a total. A record the chain contradicted is nobody's.
 * 2. **One transaction, one trade per stock.** A basket of four is four trades on one hash; the
 *    same (hash, stock, side) filed twice is one.
 *
 * Scale is handled by **daily rollups**: a finished day is reduced once to a `DayRollup` (its
 * counters, its wallets, its per-stock and per-route breakdowns) and stored; from then on the
 * live computation reads only the records of the recent days and adds the rollups for the rest.
 * The totals stay reproducible — a rollup is the same function over the same records — while the
 * cost of `/stats` stops growing with the number of records ever written.
 */
export interface StatsAsset {
  canonicalId: string;
  address: Address;
  symbol: string;
  underlying: string;
  decimals: number;
  /** USD per one raw token unit, now; null when no price is known. */
  priceUsd: number | null;
}

export interface StatsInput {
  now: number;
  assets: StatsAsset[];
  trades: TradeRecord[];
  gifts: GiftRecord[];
  executions: PortfolioExecution[];
  earnActions: EarnActionRecord[];
  pools: PoolRecord[];
  poolClaims: PoolClaim[];
  rules: AutomationRule[];
  profiles: Profile[];
  baskets: CommunityBasket[];
  watchlists: { entries: number; wallets: number };
  portfolioWallets: number;
  digests: { count: number; costUsd: number };
  aiSpendUsd: number;
  /** Receipt states by lowercase hash. A referenced hash with no entry is pending. */
  receipts: Map<string, ReceiptState>;
  /** Hashes that were not even asked about this time (over the budget); reported, treated as pending. */
  unchecked?: number;
  /**
   * Finished days already reduced to rollups. Events on or after `liveSince` come from the
   * records handed in; the rollups cover the days before it. Without `liveSince` the records are
   * taken to be everything and the rollups are ignored.
   */
  rollups?: DayRollup[];
  liveSince?: number;
}

type State = "verified" | "reverted" | "pending";

interface StatEvent {
  kind: LedgerKind;
  /** Unix ms: the block time when the receipt has it, else the app's clock. */
  at: number;
  wallet: string;
  txHash: string;
  usd: number | null;
  state: State;
  blockNumber?: number;
  symbol?: string;
  label: string;
  side?: "buy" | "sell";
  provider?: string;
  /** Stock that changed hands, in token units, per asset (gifts and claims). */
  units?: Array<{ assetId: string; units: number }>;
  /** The integrator fee this trade carried, in USD, when the route charged one. */
  feeUsd?: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const WINDOWS: Array<{ key: StatsWindowKey; ms: number | null }> = [
  { key: "24h", ms: 24 * 3600_000 },
  { key: "7d", ms: 7 * 24 * 3600_000 },
  { key: "30d", ms: 30 * 24 * 3600_000 },
  { key: "all", ms: null },
];
const DAILY_DAYS = 30;
const LEDGER_MAX = 40;

const lower = (s: string | undefined | null) => (s ?? "").toLowerCase();
const isHash = (h: string | undefined | null): h is Hash => !!h && /^0x[0-9a-fA-F]{64}$/.test(h);
const round2 = (n: number) => Math.round(n * 100) / 100;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Extracted {
  events: StatEvent[];
  execStats: { started: number; complete: number; partial: number; failed: number; legsConfirmed: number; legsFailed: number; usd: number };
  basketsBuiltAt: number[];
  direct: { sendExisting: number; buyForRecipient: number; valueUsdToday: number };
  links: { created: number; claimed: number; reclaimed: number; open: number; expired: number; valueUsdToday: number };
  poolStats: { created: number; live: number; closed: number; slots: number; claimsConfirmed: number; claimsReconciled: number; sharesValueUsdToday: number };
  autoInvest: { plans: number; active: number; paused: number; cancelled: number; runs: number; keeperRuns: number; walletRuns: number; failedRuns: number; usd: number };
  manualPlans: { plans: number; active: number; runs: number; usd: number };
  runsAt: Array<{ at: number; usd: number }>;
  known: Set<string>;
  referenced: Set<string>;
  withoutTx: number;
  duplicatesCollapsed: number;
  withoutUsd: number;
  disownedRecords: number;
  /** Stock per trade hash, for execution legs that carry no units of their own. */
  assetByTx: Map<string, string>;
}

/** Every record turned into events with the chain's verdict attached, plus the per-record status counters. */
function extractEvents(input: StatsInput): Extracted {
  const { now } = input;
  const assetById = new Map(input.assets.map((a) => [a.canonicalId, a]));
  const symbolOf = (address: string) => assetById.get(lower(address))?.symbol ?? address.slice(0, 8);
  const unitsOf = (address: string, raw: string) => {
    const a = assetById.get(lower(address));
    return a ? Number(formatUnits(BigInt(raw), a.decimals)) : 0;
  };
  const usdToday = (address: string, raw: string) => {
    const a = assetById.get(lower(address));
    if (!a || a.priceUsd === null) return null;
    return Number(formatUnits(BigInt(raw), a.decimals)) * a.priceUsd;
  };

  const stateOf = (hash: string | undefined): State => {
    const r = input.receipts.get(lower(hash));
    if (!r) return "pending";
    return r.status === "success" ? "verified" : r.status === "reverted" ? "reverted" : "pending";
  };
  /**
   * A browser-filed record counts only once the server matched it to the chain (`verifiedAt`);
   * one the chain contradicted (`verifyNote` on a failed record) is nobody's and is left out
   * entirely, not even as a failure. Records the server wrote itself carry `verifiedAt` from birth.
   */
  const recordState = (r: { verifiedAt?: number; verifyNote?: string; status?: string }, hash: string | undefined): State | "disowned" => {
    if (r.status === "failed" && r.verifyNote && r.verifyNote !== "reverted") return "disowned";
    const s = stateOf(hash);
    if (s !== "verified") return s;
    return r.verifiedAt !== undefined ? "verified" : "pending";
  };
  const atOf = (hash: string | undefined, fallbackMs: number) => {
    const r = input.receipts.get(lower(hash));
    return r?.blockTime ? r.blockTime * 1000 : fallbackMs;
  };
  const blockOf = (hash: string | undefined) => input.receipts.get(lower(hash))?.blockNumber;

  const events: StatEvent[] = [];
  const known = new Set<string>();
  const referenced = new Set<string>();
  const assetByTx = new Map<string, string>();
  let withoutTx = 0;
  let duplicatesCollapsed = 0;
  let withoutUsd = 0;
  let disownedRecords = 0;

  /* -------------------------------- trades -------------------------------- */
  const tradeKeys = new Set<string>();
  const tradeUsdByTx = new Map<string, number | null>();
  for (const t of [...input.trades].sort((a, b) => a.createdAt - b.createdAt)) {
    known.add(lower(t.owner));
    if (!isHash(t.txHash)) {
      withoutTx += 1;
      continue;
    }
    const tx = lower(t.txHash);
    referenced.add(tx);
    if (!assetByTx.has(tx)) assetByTx.set(tx, lower(t.assetAddress));
    const key = `${tx}:${lower(t.assetAddress)}:${t.side}`;
    if (tradeKeys.has(key)) {
      duplicatesCollapsed += 1;
      continue;
    }
    const state = recordState(t, tx);
    if (state === "disowned") {
      disownedRecords += 1;
      continue;
    }
    tradeKeys.add(key);
    if (!tradeUsdByTx.has(tx)) tradeUsdByTx.set(tx, t.usdValue);
    if (state === "verified" && t.usdValue === null) withoutUsd += 1;
    const feeUsd = t.feeBps && t.usdValue !== null ? (t.usdValue * t.feeBps) / 10_000 : undefined;
    events.push({ kind: t.side, at: atOf(tx, t.createdAt), wallet: lower(t.owner), txHash: tx, usd: t.usdValue, state, blockNumber: blockOf(tx), symbol: symbolOf(t.assetAddress), label: t.side === "buy" ? "Bought" : "Sold", side: t.side, provider: t.provider, units: [{ assetId: lower(t.assetAddress), units: unitsOf(t.assetAddress, t.side === "buy" ? t.buyAmount : t.sellAmount) }], feeUsd });
  }

  /* ------------------------------ executions ------------------------------ */
  const execStats = { started: 0, complete: 0, partial: 0, failed: 0, legsConfirmed: 0, legsFailed: 0, usd: 0 };
  /** Baskets with at least one leg that landed, by when they were started (for the windows). */
  const basketsBuiltAt: number[] = [];
  for (const e of input.executions) {
    known.add(lower(e.owner));
    const submitted = e.steps.filter((s) => isHash(s.txHash));
    if (submitted.length === 0) continue;
    execStats.started += 1;
    let confirmed = 0;
    let failed = 0;
    let usd = 0;
    for (const s of e.steps) {
      if (!isHash(s.txHash)) {
        if (s.status === "failed") failed += 1;
        continue;
      }
      const tx = lower(s.txHash);
      referenced.add(tx);
      const state = stateOf(tx);
      if (state === "verified") {
        confirmed += 1;
        usd += s.targetUsd;
      } else if (state === "reverted") failed += 1;
      // A leg the trade rows do not know (the record request failed, or the wallet declined to sign in) still counts once.
      const side = s.side ?? "buy";
      const key = `${tx}:${lower(s.assetAddress)}:${side}`;
      if (tradeKeys.has(key)) continue;
      tradeKeys.add(key);
      events.push({ kind: side, at: atOf(tx, e.createdAt), wallet: lower(e.owner), txHash: tx, usd: s.targetUsd, state, blockNumber: blockOf(tx), symbol: symbolOf(s.assetAddress), label: side === "buy" ? "Bought" : "Sold", side, provider: s.provider ?? "basket", units: [{ assetId: lower(s.assetAddress), units: 0 }] });
    }
    execStats.legsConfirmed += confirmed;
    execStats.legsFailed += failed;
    execStats.usd += usd;
    if (confirmed === 0) execStats.failed += 1;
    else if (confirmed === e.steps.length) execStats.complete += 1;
    else execStats.partial += 1;
    if (confirmed > 0) basketsBuiltAt.push(atOf(submitted[0]!.txHash, e.createdAt));
  }

  /* -------------------------------- gifts -------------------------------- */
  const direct = { sendExisting: 0, buyForRecipient: 0, valueUsdToday: 0 };
  const links = { created: 0, claimed: 0, reclaimed: 0, open: 0, expired: 0, valueUsdToday: 0 };
  for (const g of input.gifts) {
    known.add(lower(g.sender));
    if (lower(g.recipient) !== ZERO) known.add(lower(g.recipient));
    if (!isHash(g.txHash)) {
      withoutTx += 1;
      continue;
    }
    const tx = lower(g.txHash);
    referenced.add(tx);
    const stateOrNot = recordState(g, tx);
    if (stateOrNot === "disowned") {
      disownedRecords += 1;
      continue;
    }
    const state: State = stateOrNot;
    const units = unitsOf(g.assetAddress, g.rawAmount);
    if (g.kind === "claim-link") {
      const at = atOf(tx, g.createdAt);
      events.push({ kind: "link", at, wallet: lower(g.sender), txHash: tx, usd: usdToday(g.assetAddress, g.rawAmount), state, blockNumber: blockOf(tx), symbol: symbolOf(g.assetAddress), label: "Gift link funded", units: [] });
      if (state !== "verified") continue;
      links.created += 1;
      links.valueUsdToday += usdToday(g.assetAddress, g.rawAmount) ?? 0;
      if (g.status === "claimed") {
        const claimTx = isHash(g.claimTx) ? lower(g.claimTx) : null;
        if (claimTx) referenced.add(claimTx);
        // "claimed" is set by the server from the escrow's own `GiftClaimed`; the record's verification covers it.
        const claimState: State = claimTx ? (stateOf(claimTx) === "reverted" ? "reverted" : "verified") : "verified";
        events.push({ kind: "link-claim", at: claimTx ? atOf(claimTx, g.createdAt) : at, wallet: lower(g.recipient), txHash: (claimTx ?? tx) as Hash, usd: usdToday(g.assetAddress, g.rawAmount), state: claimState, blockNumber: claimTx ? blockOf(claimTx) : undefined, symbol: symbolOf(g.assetAddress), label: "Gift link claimed", units: [{ assetId: lower(g.assetAddress), units }] });
        if (claimState === "verified") links.claimed += 1;
      } else if (g.status === "reclaimed") links.reclaimed += 1;
      else if (g.expiresAt && g.expiresAt <= now) links.expired += 1;
      else links.open += 1;
      continue;
    }
    const usd = tradeUsdByTx.get(tx) ?? usdToday(g.assetAddress, g.rawAmount);
    events.push({ kind: "gift", at: atOf(tx, g.createdAt), wallet: lower(g.sender), txHash: tx, usd, state, blockNumber: blockOf(tx), symbol: symbolOf(g.assetAddress), label: g.kind === "buy-for-recipient" ? "Bought as a gift" : "Sent as a gift", units: [{ assetId: lower(g.assetAddress), units }] });
    if (state !== "verified") continue;
    if (g.kind === "buy-for-recipient") direct.buyForRecipient += 1;
    else direct.sendExisting += 1;
    direct.valueUsdToday += usdToday(g.assetAddress, g.rawAmount) ?? 0;
  }

  /* -------------------------------- pools -------------------------------- */
  const poolStats = { created: 0, live: 0, closed: 0, slots: 0, claimsConfirmed: 0, claimsReconciled: 0, sharesValueUsdToday: 0 };
  const poolById = new Map(input.pools.map((p) => [p.id, p]));
  for (const p of input.pools) {
    known.add(lower(p.creator));
    if (p.status === "draft" || !isHash(p.txHash)) {
      withoutTx += 1;
      continue;
    }
    const tx = lower(p.txHash);
    referenced.add(tx);
    const stateOrNot = recordState(p, tx);
    if (stateOrNot === "disowned") {
      disownedRecords += 1;
      continue;
    }
    const state: State = stateOrNot;
    const perClaimUsd = p.legs.reduce((s, l) => s + (usdToday(l.token, l.amountPerClaim) ?? 0), 0);
    events.push({ kind: "pool", at: atOf(tx, p.createdAt), wallet: lower(p.creator), txHash: tx, usd: perClaimUsd * p.slots, state, blockNumber: blockOf(tx), symbol: p.legs.length === 1 ? symbolOf(p.legs[0]!.token) : `${p.legs.length} stocks`, label: `Gift pool funded · ${p.slots} shares`, units: [] });
    if (state !== "verified") continue;
    poolStats.created += 1;
    poolStats.slots += p.slots;
    poolStats.sharesValueUsdToday += perClaimUsd * p.slots;
    const open = (p.status === "submitted" || p.status === "live") && p.expiry > now;
    if (open) poolStats.live += 1;
    else poolStats.closed += 1;
  }
  for (const c of input.poolClaims) {
    known.add(lower(c.claimant));
    if (c.status === "issued" || !isHash(c.txHash)) continue;
    const tx = lower(c.txHash);
    referenced.add(tx);
    const pool = poolById.get(c.poolId);
    // Only a row matched against a `PoolClaimed` log is proof; a page-reported one is pending until the sweep matches it.
    const state: State = c.status === "reconciled" ? "verified" : stateOf(tx) === "reverted" ? "reverted" : "pending";
    const usd = pool ? pool.legs.reduce((s, l) => s + (usdToday(l.token, l.amountPerClaim) ?? 0), 0) : null;
    events.push({
      kind: "pool-claim",
      at: atOf(tx, c.createdAt),
      wallet: lower(c.claimant),
      txHash: tx,
      usd,
      state,
      blockNumber: blockOf(tx) ?? c.blockNumber,
      symbol: pool ? (pool.legs.length === 1 ? symbolOf(pool.legs[0]!.token) : `${pool.legs.length} stocks`) : undefined,
      label: "Pool share claimed",
      units: pool ? pool.legs.map((l) => ({ assetId: lower(l.token), units: unitsOf(l.token, l.amountPerClaim) })) : [],
    });
    if (state === "verified") poolStats.claimsReconciled += 1;
    else if (c.status === "confirmed") poolStats.claimsConfirmed += 1;
  }

  /* --------------------------------- earn --------------------------------- */
  for (const a of input.earnActions) {
    known.add(lower(a.owner));
    if (!isHash(a.txHash)) {
      withoutTx += 1;
      continue;
    }
    const tx = lower(a.txHash);
    referenced.add(tx);
    if (a.verifyNote && !a.verifiedAt) {
      disownedRecords += 1;
      continue;
    }
    // Lending venues move USDC; liquidity positions move stock and USDC and are kept apart.
    const lp = a.provider === "uniswap" || a.provider === "aerodrome";
    const kind: LedgerKind = lp ? (a.action === "deposit" ? "lp-add" : a.action === "withdraw" ? "lp-remove" : "lp-collect") : a.action === "deposit" ? "earn-deposit" : "earn-withdraw";
    const label = lp ? (a.action === "deposit" ? "Liquidity added" : a.action === "withdraw" ? "Liquidity withdrawn" : "Fees collected") : a.action === "deposit" ? "USDC deposited" : "USDC withdrawn";
    events.push({ kind, at: atOf(tx, a.createdAt), wallet: lower(a.owner), txHash: tx, usd: a.usdValue, state: recordState(a, tx) as State, blockNumber: blockOf(tx), label, provider: a.provider, units: [] });
  }

  /* --------------------------------- plans -------------------------------- */
  const autoInvest = { plans: 0, active: 0, paused: 0, cancelled: 0, runs: 0, keeperRuns: 0, walletRuns: 0, failedRuns: 0, usd: 0 };
  const manualPlans = { plans: 0, active: 0, runs: 0, usd: 0 };
  /** Runs that bought something, by when they ran (for the windows); one per hash. */
  const runsAt: Array<{ at: number; usd: number }> = [];
  const runHashes = new Set<string>();
  for (const r of input.rules) {
    known.add(lower(r.owner));
    if (r.type === "drift-alert") continue;
    const auto = r.config.mode === "auto";
    if (auto) {
      autoInvest.plans += 1;
      const status = r.config.onchain?.status ?? r.status;
      if (status === "active") autoInvest.active += 1;
      else if (status === "paused") autoInvest.paused += 1;
      else if (status === "cancelled") autoInvest.cancelled += 1;
    } else {
      manualPlans.plans += 1;
      if (r.status === "active") manualPlans.active += 1;
    }
    for (const h of r.config.history ?? []) {
      if (!h.ok) {
        if (auto) autoInvest.failedRuns += 1;
        continue;
      }
      // A toward-target run that found the mix in balance did its job without buying; it is not a purchase.
      if (h.note && !(h.spentUsd && h.spentUsd > 0)) continue;
      const tx = isHash(h.txHash) ? lower(h.txHash) : null;
      if (tx) {
        if (runHashes.has(tx)) continue;
        runHashes.add(tx);
        referenced.add(tx);
        if (stateOf(tx) !== "verified") continue;
      }
      const usd = h.spentUsd ?? (h.legs ?? []).reduce((s, l) => s + l.spentUsd, 0);
      runsAt.push({ at: tx ? atOf(tx, h.at) : h.at, usd });
      if (auto) {
        autoInvest.runs += 1;
        autoInvest.usd += usd;
        if (h.via === "keeper") autoInvest.keeperRuns += 1;
        else autoInvest.walletRuns += 1;
      } else {
        manualPlans.runs += 1;
        manualPlans.usd += usd;
      }
    }
  }

  // A run the plan's history never got (a rule cancelled and recreated, a history write that
  // failed) still left its trade rows, all on one hash and all marked auto-invest: count it once.
  const autoByTx = new Map<string, { at: number; usd: number }>();
  for (const e of events) {
    if (e.state !== "verified" || e.provider !== "auto-invest" || runHashes.has(e.txHash)) continue;
    const cur = autoByTx.get(e.txHash) ?? { at: e.at, usd: 0 };
    cur.usd += e.usd ?? 0;
    autoByTx.set(e.txHash, cur);
  }
  for (const [tx, run] of autoByTx) {
    runHashes.add(tx);
    runsAt.push(run);
    autoInvest.runs += 1;
    autoInvest.usd += run.usd;
  }

  for (const p of input.profiles) known.add(lower(p.address));
  for (const b of input.baskets) known.add(lower(b.owner));

  return { events, execStats, basketsBuiltAt, direct, links, poolStats, autoInvest, manualPlans, runsAt, known, referenced, withoutTx, duplicatesCollapsed, withoutUsd, disownedRecords, assetByTx };
}

/* ------------------------------ reductions ------------------------------ */

const emptySummary = (): StatsSummary => ({ trades: 0, tradeVolumeUsd: 0, buys: 0, buyVolumeUsd: 0, sells: 0, sellVolumeUsd: 0, wallets: 0, directGifts: 0, linksCreated: 0, linksClaimed: 0, poolsCreated: 0, poolClaims: 0, earnDeposits: 0, earnDepositUsd: 0, earnWithdrawals: 0, earnWithdrawalUsd: 0, lpAdds: 0, lpAddUsd: 0, basketsBuilt: 0, planRuns: 0, planRunUsd: 0, reverted: 0 });

/** Counters over the events at or after `since`; `wallets` is the set behind `summary.wallets`. */
function summarize(events: StatEvent[], since: number, basketsBuiltAt: number[], runsAt: Array<{ at: number; usd: number }>): { summary: StatsSummary; wallets: Set<string> } {
  const s = emptySummary();
  const wallets = new Set<string>();
  for (const e of events) {
    if (e.at < since) continue;
    if (e.state === "reverted") {
      s.reverted += 1;
      continue;
    }
    if (e.state !== "verified") continue;
    wallets.add(e.wallet);
    const usd = e.usd ?? 0;
    switch (e.kind) {
      case "buy":
        s.trades += 1;
        s.buys += 1;
        s.tradeVolumeUsd += usd;
        s.buyVolumeUsd += usd;
        break;
      case "sell":
        s.trades += 1;
        s.sells += 1;
        s.tradeVolumeUsd += usd;
        s.sellVolumeUsd += usd;
        break;
      case "gift":
        s.directGifts += 1;
        break;
      case "link":
        s.linksCreated += 1;
        break;
      case "link-claim":
        s.linksClaimed += 1;
        break;
      case "pool":
        s.poolsCreated += 1;
        break;
      case "pool-claim":
        s.poolClaims += 1;
        break;
      case "earn-deposit":
        s.earnDeposits += 1;
        s.earnDepositUsd += usd;
        break;
      case "earn-withdraw":
        s.earnWithdrawals += 1;
        s.earnWithdrawalUsd += usd;
        break;
      case "lp-add":
        s.lpAdds += 1;
        s.lpAddUsd += usd;
        break;
      default:
        break;
    }
  }
  s.basketsBuilt = basketsBuiltAt.filter((at) => at >= since).length;
  for (const r of runsAt) {
    if (r.at < since) continue;
    s.planRuns += 1;
    s.planRunUsd += r.usd;
  }
  s.wallets = wallets.size;
  return { summary: s, wallets };
}

/** Adds a rollup's counters onto a summary (the event-derived fields only; baskets and plan runs stay record-derived). */
function addRollupSummary(s: StatsSummary, r: DayRollup): void {
  const src = r.summary;
  s.trades += src.trades;
  s.tradeVolumeUsd += src.tradeVolumeUsd;
  s.buys += src.buys;
  s.buyVolumeUsd += src.buyVolumeUsd;
  s.sells += src.sells;
  s.sellVolumeUsd += src.sellVolumeUsd;
  s.directGifts += src.directGifts;
  s.linksCreated += src.linksCreated;
  s.linksClaimed += src.linksClaimed;
  s.poolsCreated += src.poolsCreated;
  s.poolClaims += src.poolClaims;
  s.earnDeposits += src.earnDeposits;
  s.earnDepositUsd += src.earnDepositUsd;
  s.earnWithdrawals += src.earnWithdrawals;
  s.earnWithdrawalUsd += src.earnWithdrawalUsd;
  s.lpAdds += src.lpAdds;
  s.lpAddUsd += src.lpAddUsd;
  s.reverted += src.reverted;
}

interface Breakdown {
  byProvider: Map<string, StatsCounter>;
  byAsset: Map<string, { buys: number; buyUsd: number; sells: number; sellUsd: number; gifted: number }>;
  earnByProvider: Map<string, { deposits: number; depositUsd: number; withdrawals: number; withdrawalUsd: number }>;
  liquidity: { added: StatsCounter; removed: StatsCounter; collected: StatsCounter };
  feeUsd: number;
}

const emptyBreakdown = (): Breakdown => ({ byProvider: new Map(), byAsset: new Map(), earnByProvider: new Map(), liquidity: { added: { count: 0, usd: 0 }, removed: { count: 0, usd: 0 }, collected: { count: 0, usd: 0 } }, feeUsd: 0 });

/** Per-route, per-stock and per-venue totals over verified events, added onto `into`. */
function breakdown(verified: StatEvent[], assetByTx: Map<string, string>, into: Breakdown = emptyBreakdown()): Breakdown {
  const assetRow = (assetId: string) => {
    const row = into.byAsset.get(assetId) ?? { buys: 0, buyUsd: 0, sells: 0, sellUsd: 0, gifted: 0 };
    into.byAsset.set(assetId, row);
    return row;
  };
  for (const e of verified) {
    if (e.kind === "buy" || e.kind === "sell") {
      const p = into.byProvider.get(e.provider ?? "unknown") ?? { count: 0, usd: 0 };
      p.count += 1;
      p.usd += e.usd ?? 0;
      into.byProvider.set(e.provider ?? "unknown", p);
      into.feeUsd += e.feeUsd ?? 0;
      const assetId = e.units?.[0]?.assetId ?? assetByTx.get(e.txHash);
      if (assetId) {
        const row = assetRow(assetId);
        if (e.kind === "buy") {
          row.buys += 1;
          row.buyUsd += e.usd ?? 0;
        } else {
          row.sells += 1;
          row.sellUsd += e.usd ?? 0;
        }
      }
      continue;
    }
    if (e.kind === "gift" || e.kind === "link-claim" || e.kind === "pool-claim") {
      for (const u of e.units ?? []) assetRow(u.assetId).gifted += u.units;
      continue;
    }
    const bucket = e.kind === "lp-add" ? into.liquidity.added : e.kind === "lp-remove" ? into.liquidity.removed : e.kind === "lp-collect" ? into.liquidity.collected : null;
    if (bucket) {
      bucket.count += 1;
      bucket.usd += e.usd ?? 0;
      continue;
    }
    if (e.kind !== "earn-deposit" && e.kind !== "earn-withdraw") continue;
    const row = into.earnByProvider.get(e.provider ?? "unknown") ?? { deposits: 0, depositUsd: 0, withdrawals: 0, withdrawalUsd: 0 };
    if (e.kind === "earn-deposit") {
      row.deposits += 1;
      row.depositUsd += e.usd ?? 0;
    } else {
      row.withdrawals += 1;
      row.withdrawalUsd += e.usd ?? 0;
    }
    into.earnByProvider.set(e.provider ?? "unknown", row);
  }
  return into;
}

function addRollupBreakdown(into: Breakdown, r: DayRollup): void {
  for (const [k, v] of Object.entries(r.byProvider)) {
    const p = into.byProvider.get(k) ?? { count: 0, usd: 0 };
    p.count += v.count;
    p.usd += v.usd;
    into.byProvider.set(k, p);
  }
  for (const [k, v] of Object.entries(r.byAsset)) {
    const row = into.byAsset.get(k) ?? { buys: 0, buyUsd: 0, sells: 0, sellUsd: 0, gifted: 0 };
    row.buys += v.buys;
    row.buyUsd += v.buyUsd;
    row.sells += v.sells;
    row.sellUsd += v.sellUsd;
    row.gifted += v.gifted;
    into.byAsset.set(k, row);
  }
  for (const [k, v] of Object.entries(r.earnByProvider)) {
    const row = into.earnByProvider.get(k) ?? { deposits: 0, depositUsd: 0, withdrawals: 0, withdrawalUsd: 0 };
    row.deposits += v.deposits;
    row.depositUsd += v.depositUsd;
    row.withdrawals += v.withdrawals;
    row.withdrawalUsd += v.withdrawalUsd;
    into.earnByProvider.set(k, row);
  }
  for (const key of ["added", "removed", "collected"] as const) {
    into.liquidity[key].count += r.liquidity[key].count;
    into.liquidity[key].usd += r.liquidity[key].usd;
  }
  into.feeUsd += r.feeUsd;
}

/* ------------------------------- rollups -------------------------------- */

/**
 * One finished day, reduced. The same extraction as the live computation, kept to the events
 * whose block time falls on `day`, so a day rolled up and a day computed live add to the same
 * totals. Records handed in should cover the day generously (a claim's record was created when
 * its link was funded, weeks before); the filter on `at` does the rest.
 */
export function buildDayRollup(input: StatsInput, day: string): DayRollup {
  const x = extractEvents(input);
  const dayEvents = x.events.filter((e) => dayKey(e.at) === day);
  const verified = dayEvents.filter((e) => e.state === "verified");
  const { summary, wallets } = summarize(dayEvents, 0, [], []);
  const b = breakdown(verified, x.assetByTx);
  const hashes = new Map<string, State>();
  for (const e of dayEvents) if (!hashes.has(e.txHash) || e.state === "verified") hashes.set(e.txHash, e.state);
  let verifiedTx = 0;
  let revertedTx = 0;
  for (const state of hashes.values()) {
    if (state === "verified") verifiedTx += 1;
    else if (state === "reverted") revertedTx += 1;
  }
  const { wallets: _w, basketsBuilt: _b, planRuns: _p, planRunUsd: _u, ...counters } = summary;
  void _w;
  void _b;
  void _p;
  void _u;
  return {
    day,
    events: verified.length,
    wallets: [...wallets],
    summary: counters,
    byProvider: Object.fromEntries(b.byProvider),
    byAsset: Object.fromEntries(b.byAsset),
    earnByProvider: Object.fromEntries(b.earnByProvider),
    liquidity: b.liquidity,
    feeUsd: b.feeUsd,
    verifiedTx,
    revertedTx,
    computedAt: input.now,
  };
}

/* ------------------------------- aggregate ------------------------------ */

export function aggregateStats(input: StatsInput): PlatformStats {
  const { now } = input;
  const assetById = new Map(input.assets.map((a) => [a.canonicalId, a]));
  const x = extractEvents(input);

  // Live events are the ones after the rollup boundary; the rollups stand for the days before.
  const liveSince = input.liveSince ?? 0;
  const liveDay = dayKey(liveSince);
  const rollups = liveSince > 0 ? (input.rollups ?? []).filter((r) => r.day < liveDay).sort((a, b) => (a.day < b.day ? -1 : 1)) : [];
  const events = liveSince > 0 ? x.events.filter((e) => e.at >= liveSince) : x.events;
  const verified = events.filter((e) => e.state === "verified");

  /* ------------------------------- windows -------------------------------- */
  const windows = {} as Record<StatsWindowKey, StatsSummary>;
  const allWallets = new Set<string>();
  for (const { key, ms } of WINDOWS) {
    const since = ms === null ? 0 : now - ms;
    const { summary, wallets } = summarize(events, since, x.basketsBuiltAt, x.runsAt);
    if (ms === null) {
      for (const w of wallets) allWallets.add(w);
      for (const r of rollups) {
        addRollupSummary(summary, r);
        for (const w of r.wallets) allWallets.add(w);
      }
      summary.wallets = allWallets.size;
    }
    windows[key] = summary;
  }

  /* ------------------------------ breakdowns ------------------------------ */
  const b = breakdown(verified, x.assetByTx);
  for (const r of rollups) addRollupBreakdown(b, r);
  const byAsset: AssetStat[] = [...b.byAsset.entries()].map(([assetId, r]) => {
    const a = assetById.get(assetId);
    return { assetAddress: (a?.address ?? assetId) as Address, symbol: a?.symbol ?? assetId.slice(0, 8), underlying: a?.underlying ?? assetId.slice(0, 8), buys: r.buys, buyUsd: round2(r.buyUsd), sells: r.sells, sellUsd: round2(r.sellUsd), gifted: Math.round(r.gifted * 1e8) / 1e8 };
  });
  const earn = { deposits: { count: 0, usd: 0 }, withdrawals: { count: 0, usd: 0 } };
  for (const v of b.earnByProvider.values()) {
    earn.deposits.count += v.deposits;
    earn.deposits.usd += v.depositUsd;
    earn.withdrawals.count += v.withdrawals;
    earn.withdrawals.usd += v.withdrawalUsd;
  }

  /* -------------------------------- people -------------------------------- */
  const known = new Set(x.known);
  for (const w of allWallets) known.add(w);

  /* --------------------------------- daily -------------------------------- */
  const daily: DailyStat[] = [];
  for (let i = DAILY_DAYS - 1; i >= 0; i--) daily.push({ day: dayKey(now - i * 24 * 3600_000), trades: 0, volumeUsd: 0, events: 0, wallets: 0 });
  const dayIndex = new Map(daily.map((d, i) => [d.day, i]));
  const dayWallets = new Map<string, Set<string>>();
  for (const e of verified) {
    const i = dayIndex.get(dayKey(e.at));
    if (i === undefined) continue;
    const d = daily[i]!;
    d.events += 1;
    if (e.kind === "buy" || e.kind === "sell") {
      d.trades += 1;
      d.volumeUsd += e.usd ?? 0;
    }
    const set = dayWallets.get(d.day) ?? new Set<string>();
    set.add(e.wallet);
    dayWallets.set(d.day, set);
  }
  // A rolled-up day inside the chart's range (the rollup boundary is closer than 30 days) reads from its rollup.
  for (const r of rollups) {
    const i = dayIndex.get(r.day);
    if (i === undefined) continue;
    const d = daily[i]!;
    d.events += r.events;
    d.trades += r.summary.trades;
    d.volumeUsd += r.summary.tradeVolumeUsd;
    const set = dayWallets.get(d.day) ?? new Set<string>();
    for (const w of r.wallets) set.add(w);
    dayWallets.set(d.day, set);
  }
  for (const d of daily) {
    d.wallets = dayWallets.get(d.day)?.size ?? 0;
    d.volumeUsd = round2(d.volumeUsd);
  }

  /* -------------------------------- ledger -------------------------------- */
  // One receipt, one line: records that share a hash and a kind (gift links funded together) fold
  // into one entry with a count, so the ledger reads like the chain does.
  const folded = new Map<string, LedgerEntry>();
  for (const e of [...verified].sort((a, b) => b.at - a.at || (b.blockNumber ?? 0) - (a.blockNumber ?? 0))) {
    const key = `${e.txHash}:${e.kind}`;
    const cur = folded.get(key);
    if (cur) {
      cur.count = (cur.count ?? 1) + 1;
      if (e.usd !== null) cur.usd = round2((cur.usd ?? 0) + e.usd);
      if (cur.symbol !== e.symbol) cur.symbol = `${cur.count} stocks`;
      continue;
    }
    folded.set(key, { at: e.at, kind: e.kind, label: e.label, symbol: e.symbol, usd: e.usd === null ? undefined : round2(e.usd), txHash: e.txHash as Hash, blockNumber: e.blockNumber });
  }
  const ledger = [...folded.values()].slice(0, LEDGER_MAX);

  /* ----------------------------- verification ----------------------------- */
  let verifiedTx = 0;
  let revertedTx = 0;
  let pendingTx = 0;
  for (const h of x.referenced) {
    const r = input.receipts.get(h);
    if (!r || r.status === "pending") pendingTx += 1;
    else if (r.status === "success") verifiedTx += 1;
    else revertedTx += 1;
  }
  for (const r of rollups) {
    verifiedTx += r.verifiedTx;
    revertedTx += r.revertedTx;
  }

  return {
    generatedAt: now,
    windows,
    trading: {
      byProvider: [...b.byProvider.entries()].map(([provider, v]) => ({ provider, count: v.count, usd: round2(v.usd) })).sort((a, b2) => b2.usd - a.usd || b2.count - a.count),
      byAsset: byAsset.sort((a, b2) => b2.buyUsd + b2.sellUsd - (a.buyUsd + a.sellUsd)),
      withoutUsd: x.withoutUsd,
      integratorFeeUsd: round2(b.feeUsd),
    },
    strategies: {
      executions: { ...x.execStats, usd: round2(x.execStats.usd) },
      autoInvest: { ...x.autoInvest, usd: round2(x.autoInvest.usd) },
      manualPlans: { ...x.manualPlans, usd: round2(x.manualPlans.usd) },
      community: { baskets: input.baskets.length, votes: input.baskets.reduce((s, bk) => s + bk.votes, 0), clones: input.baskets.reduce((s, bk) => s + bk.clones, 0) },
    },
    gifts: {
      direct: { ...x.direct, valueUsdToday: round2(x.direct.valueUsdToday) },
      links: { ...x.links, valueUsdToday: round2(x.links.valueUsdToday) },
      pools: { ...x.poolStats, sharesValueUsdToday: round2(x.poolStats.sharesValueUsdToday) },
    },
    earn: {
      deposits: { count: earn.deposits.count, usd: round2(earn.deposits.usd) },
      withdrawals: { count: earn.withdrawals.count, usd: round2(earn.withdrawals.usd) },
      byProvider: [...b.earnByProvider.entries()].map(([provider, v]) => ({ provider, deposits: v.deposits, depositUsd: round2(v.depositUsd), withdrawals: v.withdrawals, withdrawalUsd: round2(v.withdrawalUsd) })).sort((a, b2) => b2.depositUsd - a.depositUsd),
      liquidity: {
        added: { count: b.liquidity.added.count, usd: round2(b.liquidity.added.usd) },
        removed: { count: b.liquidity.removed.count, usd: round2(b.liquidity.removed.usd) },
        collected: { count: b.liquidity.collected.count, usd: round2(b.liquidity.collected.usd) },
      },
    },
    people: {
      transactingWallets: allWallets.size,
      knownWallets: known.size,
      profiles: input.profiles.length,
      publicProfiles: input.profiles.filter((p) => p.isPublic).length,
      watchlistEntries: input.watchlists.entries,
      watchlistWallets: input.watchlists.wallets,
      portfolioWallets: input.portfolioWallets,
      aiBriefs: input.digests.count,
      aiSpendUsd: round2(input.aiSpendUsd),
    },
    daily,
    ledger,
    verification: { verified: verifiedTx, reverted: revertedTx, pending: pendingTx, withoutTx: x.withoutTx, duplicatesCollapsed: x.duplicatesCollapsed, disowned: x.disownedRecords, unchecked: input.unchecked ?? 0 },
    rollup: { days: rollups.length, through: rollups.length ? rollups[rollups.length - 1]!.day : null, liveSince: liveSince > 0 ? liveSince : null },
  };
}

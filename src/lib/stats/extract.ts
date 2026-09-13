import { formatUnits, type Address, type Hash } from "viem";
import type { DayRollup, LedgerKind } from "@/domain/stats";
import type { GiftRecord } from "@/domain/gift";
import type { PoolClaim, PoolRecord } from "@/domain/pool";
import type { PortfolioExecution } from "@/domain/portfolio";
import type { EarnActionRecord, TradeRecord } from "@/db/repositories";
import type { AutomationRule, CommunityBasket, Profile } from "@/domain/community";
import type { ReceiptState } from "@/services/receipt-service";

/**
 * The first stage of the platform statistics: every record turned into an event with the chain's
 * verdict attached. Pure. `summarize.ts` reduces the events, `rollup.ts` stores a finished day,
 * `aggregate.ts` assembles the page.
 *
 * Two rules everything here follows:
 *
 * 1. **A record counts once the chain agrees.** Every event carries the state of its receipt, and
 *    only `verified` events reach a total. A record the chain contradicted is nobody's.
 * 2. **One transaction, one trade per stock.** A basket of four is four trades on one hash; the
 *    same (hash, stock, side) filed twice is one.
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
  /**
   * Every wallet any table names, counted by the database. When present it replaces the count
   * derived from the records in hand, which after rollups only cover the live window.
   */
  knownWalletCount?: number;
}

export type State = "verified" | "reverted" | "pending";

export interface StatEvent {
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

export const lower = (s: string | undefined | null) => (s ?? "").toLowerCase();
export const isHash = (h: string | undefined | null): h is Hash => !!h && /^0x[0-9a-fA-F]{64}$/.test(h);
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface Extracted {
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
export function extractEvents(input: StatsInput): Extracted {
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
  /** Every (hash, stock, side) the trade rows account for, with the verdict the server reached on it. */
  const tradeByKey = new Map<string, { state: State; usd: number | null }>();
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
    if (tradeByKey.has(key)) {
      duplicatesCollapsed += 1;
      continue;
    }
    const state = recordState(t, tx);
    if (state === "disowned") {
      disownedRecords += 1;
      continue;
    }
    tradeByKey.set(key, { state, usd: t.usdValue });
    if (!tradeUsdByTx.has(tx)) tradeUsdByTx.set(tx, t.usdValue);
    if (state === "verified" && t.usdValue === null) withoutUsd += 1;
    const feeUsd = t.feeBps && t.usdValue !== null ? (t.usdValue * t.feeBps) / 10_000 : undefined;
    events.push({ kind: t.side, at: atOf(tx, t.createdAt), wallet: lower(t.owner), txHash: tx, usd: t.usdValue, state, blockNumber: blockOf(tx), symbol: symbolOf(t.assetAddress), label: t.side === "buy" ? "Bought" : "Sold", side: t.side, provider: t.provider, units: [{ assetId: lower(t.assetAddress), units: unitsOf(t.assetAddress, t.side === "buy" ? t.buyAmount : t.sellAmount) }], feeUsd });
  }

  /* ------------------------------ executions ------------------------------ */
  /**
   * A basket leg counts the way its trade row counts, and only that way. The executor writes a
   * trade row for every leg it sends, and the server matches that row to the receipt (the stock
   * arrived in the owner's wallet, the USDC that paid for it); a leg whose row never arrived or
   * never verified is pending, whatever its receipt's status says. Counting a leg on "the receipt
   * succeeded" alone let any successful hash, with any `targetUsd`, be PATCHed into the figures.
   */
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
    let firstConfirmedAt: number | null = null;
    for (const s of e.steps) {
      if (!isHash(s.txHash)) {
        if (s.status === "failed") failed += 1;
        continue;
      }
      const tx = lower(s.txHash);
      referenced.add(tx);
      const side = s.side ?? "buy";
      const key = `${tx}:${lower(s.assetAddress)}:${side}`;
      const row = tradeByKey.get(key);
      const receipt = stateOf(tx);
      // The verdict the server reached on the matching trade row; without one, a reverted receipt is
      // a failure and anything else is still pending.
      const state: State = row ? row.state : receipt === "reverted" ? "reverted" : "pending";
      if (state === "verified") {
        confirmed += 1;
        usd += row?.usd ?? s.targetUsd;
        if (firstConfirmedAt === null) firstConfirmedAt = atOf(tx, e.createdAt);
      } else if (state === "reverted") failed += 1;
      // The trade row already made this leg an event; a leg with no row is recorded as pending so the
      // verification block can say how many legs are waiting on their rows.
      if (row) continue;
      tradeByKey.set(key, { state, usd: null });
      events.push({ kind: side, at: atOf(tx, e.createdAt), wallet: lower(e.owner), txHash: tx, usd: s.targetUsd, state, blockNumber: blockOf(tx), symbol: symbolOf(s.assetAddress), label: side === "buy" ? "Bought" : "Sold", side, provider: s.provider ?? "basket", units: [{ assetId: lower(s.assetAddress), units: 0 }] });
    }
    execStats.legsConfirmed += confirmed;
    execStats.legsFailed += failed;
    execStats.usd += usd;
    if (confirmed === 0) execStats.failed += 1;
    else if (confirmed === e.steps.length) execStats.complete += 1;
    else execStats.partial += 1;
    if (confirmed > 0 && firstConfirmedAt !== null) basketsBuiltAt.push(firstConfirmedAt);
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

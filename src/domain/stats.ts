import type { Address, Hash } from "viem";

/**
 * Platform statistics: what has been done through BStocks, counted from the app's own records and
 * verified against Base. Every figure that involves a transaction counts only transactions whose
 * receipt on Base says `success`; the verification block says how many records did not make it.
 */

export type StatsWindowKey = "24h" | "7d" | "30d" | "all";

export interface StatsSummary {
  /** Trades (one per transaction and stock; a basket of four is four trades, one auto-invest run of three is three). */
  trades: number;
  /** USD the trades moved, from the record the app wrote when the quote was taken. */
  tradeVolumeUsd: number;
  buys: number;
  buyVolumeUsd: number;
  sells: number;
  sellVolumeUsd: number;
  /** Distinct wallets with at least one verified action in the window. */
  wallets: number;
  /** Gifts delivered straight to a wallet or Basename (send-existing, buy-for-recipient). */
  directGifts: number;
  linksCreated: number;
  linksClaimed: number;
  poolsCreated: number;
  poolClaims: number;
  /** USDC put into lending venues (Morpho, Aave, Compound); liquidity positions are counted apart. */
  earnDeposits: number;
  earnDepositUsd: number;
  earnWithdrawals: number;
  earnWithdrawalUsd: number;
  /** Liquidity positions opened in the app (stock + USDC, valued when minted). */
  lpAdds: number;
  lpAddUsd: number;
  /** Baskets and rebalances with at least one leg that landed. */
  basketsBuilt: number;
  /** AutoInvest and manual plan runs that bought something. */
  planRuns: number;
  planRunUsd: number;
  /** Transactions that reverted onchain, of any kind. */
  reverted: number;
}

export interface StatsCounter {
  count: number;
  usd: number;
}

export interface ProviderStat extends StatsCounter {
  provider: string;
}

export interface AssetStat {
  assetAddress: Address;
  symbol: string;
  underlying: string;
  buys: number;
  buyUsd: number;
  sells: number;
  sellUsd: number;
  /** Stock given away (direct gifts, links claimed, pool shares claimed), in token units. */
  gifted: number;
}

export interface DailyStat {
  /** YYYY-MM-DD, UTC. */
  day: string;
  trades: number;
  volumeUsd: number;
  /** Every verified event (trades, gifts, claims, deposits). */
  events: number;
  wallets: number;
}

export type LedgerKind = "buy" | "sell" | "gift" | "link" | "link-claim" | "pool" | "pool-claim" | "earn-deposit" | "earn-withdraw" | "lp-add" | "lp-remove" | "lp-collect" | "basket" | "plan-run";

/** One verified event, no wallet shown: the hash is the proof and Basescan has the rest. */
export interface LedgerEntry {
  at: number;
  kind: LedgerKind;
  label: string;
  symbol?: string;
  usd?: number;
  txHash: Hash;
  blockNumber?: number;
  /** Records this line stands for when several share one transaction (gift links funded together). */
  count?: number;
}

export interface PlatformStats {
  generatedAt: number;
  /** Where the timestamps come from: the block when the receipt was read, else the app's own clock. */
  windows: Record<StatsWindowKey, StatsSummary>;
  trading: {
    byProvider: ProviderStat[];
    byAsset: AssetStat[];
    /** Trades the app recorded without a USD value; counted, not summed. */
    withoutUsd: number;
  };
  strategies: {
    executions: { started: number; complete: number; partial: number; failed: number; legsConfirmed: number; legsFailed: number; usd: number };
    autoInvest: { plans: number; active: number; paused: number; cancelled: number; runs: number; keeperRuns: number; walletRuns: number; failedRuns: number; usd: number };
    manualPlans: { plans: number; active: number; runs: number; usd: number };
    community: { baskets: number; votes: number; clones: number };
  };
  gifts: {
    direct: { sendExisting: number; buyForRecipient: number; valueUsdToday: number };
    links: { created: number; claimed: number; reclaimed: number; open: number; expired: number; valueUsdToday: number };
    pools: { created: number; live: number; closed: number; slots: number; claimsConfirmed: number; claimsReconciled: number; sharesValueUsdToday: number };
  };
  earn: {
    /** Lending venues: USDC in and out. */
    deposits: StatsCounter;
    withdrawals: StatsCounter;
    byProvider: Array<{ provider: string; deposits: number; depositUsd: number; withdrawals: number; withdrawalUsd: number }>;
    /** Concentrated-liquidity positions opened, reduced and harvested in the app (USD at the pool price at the time). */
    liquidity: { added: StatsCounter; removed: StatsCounter; collected: StatsCounter };
  };
  people: {
    /** Wallets with at least one verified onchain action through the app. */
    transactingWallets: number;
    /** Every wallet the app has any record of (transacting, profiles, baskets, plans, gift recipients). */
    knownWallets: number;
    profiles: number;
    publicProfiles: number;
    watchlistEntries: number;
    watchlistWallets: number;
    /** Wallets with at least one daily portfolio snapshot (they opened Portfolio at least once). */
    portfolioWallets: number;
    aiBriefs: number;
    aiSpendUsd: number;
  };
  daily: DailyStat[];
  ledger: LedgerEntry[];
  verification: {
    /** Transactions the app recorded, by what the chain said about them. */
    verified: number;
    reverted: number;
    pending: number;
    /** Records with no transaction hash at all (abandoned reviews, drafts); never counted. */
    withoutTx: number;
    /** Duplicate rows for one (transaction, stock, side) collapsed into one trade. */
    duplicatesCollapsed: number;
    /** Hashes whose receipt could not be read this time (counted as pending). */
    unchecked: number;
  };
}

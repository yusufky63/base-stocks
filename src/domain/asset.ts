import type { Address } from "viem";
import type { ReferenceFreshness } from "@/lib/market-hours";

export type AssetStatus = "active" | "restricted" | "paused" | "unknown";

/** Market category tags used by the Markets screen filters. */
export type MarketTag = "technology" | "ai" | "finance" | "crypto" | "semiconductors" | "other";

export interface OracleState {
  feed: Address;
  answer: bigint;
  updatedAt: bigint;
  decimals: number;
  /** OracleRegistry pause flag for this token (corporate action freeze). */
  paused: boolean;
  /** `now - updatedAt > threshold` (threshold ≈ the 24h Chainlink heartbeat + margin). Never hidden from the user. */
  stale: boolean;
  staleAfterSeconds: number;
  /** live / last-close (market closed, feed holding the close) / stale / frozen (registry pause). */
  freshness: ReferenceFreshness;
  marketOpen: boolean;
  /** Price per ONE raw token (total-return, already multiplier-adjusted). */
  priceUsd: number;
}

/** ERC-8056 scheduled multiplier change (advance onchain notice of a corporate action). */
export interface PendingMultiplier {
  multiplier: bigint;
  /** Unix seconds. */
  effectiveAt: bigint;
}

/**
 * Canonical B20 asset. Identity is ALWAYS `address` (lowercased in `canonicalId`).
 * Symbols and names are mutable onchain metadata and must not be used as identity.
 */
export interface B20Asset {
  address: Address;
  canonicalId: string;

  name: string;
  symbol: string;
  /** Underlying equity ticker (display only). */
  underlying: string;
  decimals: number;
  contractURI?: string;
  logoURI?: string;
  tags: MarketTag[];

  /** WAD (1e18) scaled redemption ratio. scaled = raw * multiplier / WAD. */
  multiplier: bigint;
  wadPrecision: bigint;
  /** Scheduled multiplier change, when the issuer has announced one onchain. */
  pendingMultiplier?: PendingMultiplier;
  /** Security identifier from `extraMetadata("isin")`, when set by the issuer. */
  isin?: string;
  /** Onchain total supply in raw units; 0 means the issuer has not minted this stock yet. */
  totalSupply: bigint;

  /** Policy ids bound to transfer scopes (sender/receiver). */
  transferSenderPolicyId: bigint;
  transferReceiverPolicyId: bigint;
  transferPaused: boolean;

  oracle?: OracleState;

  status: AssetStatus;
  /** Admin verification state: only `verified` assets are tradable in the UI. */
  verification: "verified" | "discovered" | "disabled";
  /** Unix ms when this snapshot was read. */
  readAt: number;
}

export interface AssetBalance {
  assetAddress: Address;
  rawBalance: bigint;
  /** Multiplier-aware economic balance, from `scaledBalanceOf`. */
  scaledBalance: bigint;
  decimals: number;
}

/** Curated registry entry: the only static data we trust for discovery. */
export interface CuratedAssetEntry {
  address: Address;
  underlying: string;
  chainlinkFeed: Address;
  tags: MarketTag[];
}

/** JSON-safe representation for API responses. */
export interface B20AssetDTO {
  address: Address;
  canonicalId: string;
  name: string;
  symbol: string;
  underlying: string;
  decimals: number;
  logoURI?: string;
  tags: MarketTag[];
  multiplier: string;
  wadPrecision: string;
  pendingMultiplier?: { multiplier: string; effectiveAt: number };
  isin?: string;
  totalSupply: string;
  transferPaused: boolean;
  transferSenderPolicyId: string;
  transferReceiverPolicyId: string;
  oracle?: {
    feed: Address;
    answer: string;
    updatedAt: number;
    decimals: number;
    paused: boolean;
    stale: boolean;
    staleAfterSeconds: number;
    freshness: ReferenceFreshness;
    marketOpen: boolean;
    priceUsd: number;
  };
  status: AssetStatus;
  verification: B20Asset["verification"];
  readAt: number;
}

export function toAssetDTO(a: B20Asset): B20AssetDTO {
  return {
    address: a.address,
    canonicalId: a.canonicalId,
    name: a.name,
    symbol: a.symbol,
    underlying: a.underlying,
    decimals: a.decimals,
    logoURI: a.logoURI,
    tags: a.tags,
    multiplier: a.multiplier.toString(),
    wadPrecision: a.wadPrecision.toString(),
    pendingMultiplier: a.pendingMultiplier ? { multiplier: a.pendingMultiplier.multiplier.toString(), effectiveAt: Number(a.pendingMultiplier.effectiveAt) } : undefined,
    isin: a.isin,
    totalSupply: a.totalSupply.toString(),
    transferPaused: a.transferPaused,
    transferSenderPolicyId: a.transferSenderPolicyId.toString(),
    transferReceiverPolicyId: a.transferReceiverPolicyId.toString(),
    oracle: a.oracle
      ? {
          feed: a.oracle.feed,
          answer: a.oracle.answer.toString(),
          updatedAt: Number(a.oracle.updatedAt),
          decimals: a.oracle.decimals,
          paused: a.oracle.paused,
          stale: a.oracle.stale,
          staleAfterSeconds: a.oracle.staleAfterSeconds,
          freshness: a.oracle.freshness,
          marketOpen: a.oracle.marketOpen,
          priceUsd: a.oracle.priceUsd,
        }
      : undefined,
    status: a.status,
    verification: a.verification,
    readAt: a.readAt,
  };
}

export function fromAssetDTO(d: B20AssetDTO): B20Asset {
  return {
    address: d.address,
    canonicalId: d.canonicalId,
    name: d.name,
    symbol: d.symbol,
    underlying: d.underlying,
    decimals: d.decimals,
    logoURI: d.logoURI,
    tags: d.tags,
    multiplier: BigInt(d.multiplier),
    wadPrecision: BigInt(d.wadPrecision),
    pendingMultiplier: d.pendingMultiplier ? { multiplier: BigInt(d.pendingMultiplier.multiplier), effectiveAt: BigInt(d.pendingMultiplier.effectiveAt) } : undefined,
    isin: d.isin,
    totalSupply: BigInt(d.totalSupply ?? "0"),
    transferPaused: d.transferPaused,
    transferSenderPolicyId: BigInt(d.transferSenderPolicyId),
    transferReceiverPolicyId: BigInt(d.transferReceiverPolicyId),
    oracle: d.oracle
      ? {
          feed: d.oracle.feed,
          answer: BigInt(d.oracle.answer),
          updatedAt: BigInt(d.oracle.updatedAt),
          decimals: d.oracle.decimals,
          paused: d.oracle.paused,
          stale: d.oracle.stale,
          staleAfterSeconds: d.oracle.staleAfterSeconds,
          freshness: d.oracle.freshness ?? (d.oracle.paused ? "frozen" : d.oracle.stale ? "stale" : "live"),
          marketOpen: d.oracle.marketOpen ?? true,
          priceUsd: d.oracle.priceUsd,
        }
      : undefined,
    status: d.status,
    verification: d.verification,
    readAt: d.readAt,
  };
}

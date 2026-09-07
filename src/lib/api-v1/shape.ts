import type { B20Asset } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import { tradingStatus } from "@/lib/trading-status";

/**
 * The public API's shapes.
 *
 * Deliberately different from the app's internal DTOs: flat instead of joined (the app ships
 * `assets[]` and `prices{}` for the UI to zip together, which a consumer should never have to do),
 * symbol-addressable, and explicit about the three things the B20 standard makes easy to get
 * wrong — see the field docs below. Everything here is derived from what the app already computed
 * for its own pages, so a public read costs no extra work upstream.
 */

export interface V1Stock {
  /** Identity. Symbols are mutable onchain metadata; the address is what a caller should store. */
  address: string;
  /** Underlying equity ticker, e.g. "NVDA". Convenient, not canonical. */
  symbol: string;
  /** The B20 token's own symbol, e.g. "NVDAc". */
  tokenSymbol: string;
  name: string;
  decimals: number;

  /**
   * One token is not one share. `scaledShares = rawTokens * multiplier / 1e18`, and the multiplier
   * moves on splits and dividends. Any conversion that skips it is wrong.
   */
  multiplier: string;
  multiplierPrecision: string;

  /** Price on the Base DEX pools — what a buyer actually pays here. Null when no pool has priced it. */
  dexPriceUsd: number | null;
  dexChange24hPct: number | null;
  dexUpdatedAt: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;

  /**
   * The Chainlink reference. NOT the raw equity price: Coinbase's feeds report total-return
   * values, so comparing this with `dexPriceUsd` and calling the gap an arbitrage is a mistake.
   * Feeds publish 24/5 and hold the last value outside trading hours — read `updatedAt` and
   * `isStale` before relying on it.
   */
  reference: {
    totalReturnUsd: number | null;
    updatedAt: number | null;
    isStale: boolean;
    /** True during a corporate action, when the issuer freezes the feed. */
    isPaused: boolean;
  } | null;

  /** What the app itself displays, and which of the two prices it chose. */
  displayUsd: number | null;
  displaySource: "market" | "reference" | "none";

  /** live | thin | very-thin | no-pool | not-issued | paused, with a human label. */
  status: { code: string; label: string; detail: string };

  /** Onchain supply in raw units; "0" means the issuer has not minted this stock yet. */
  totalSupply: string;
  transferPaused: boolean;
  tags: string[];
  logoUrl?: string;
}

export function toV1Stock(asset: B20Asset, price: PriceView | undefined): V1Stock {
  const status = tradingStatus(
    { status: asset.status, totalSupply: asset.totalSupply.toString(), supplyKnown: asset.supplyKnown },
    price ? { liquidityUsd: price.liquidityUsd, volume24hUsd: price.volume24hUsd } : null,
  );
  return {
    address: asset.address,
    symbol: asset.underlying,
    tokenSymbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    multiplier: asset.multiplier.toString(),
    multiplierPrecision: asset.wadPrecision.toString(),
    dexPriceUsd: price?.marketUsd ?? null,
    dexChange24hPct: price?.marketChange24hPct ?? null,
    dexUpdatedAt: price?.marketUpdatedAt ?? null,
    liquidityUsd: price?.liquidityUsd ?? null,
    volume24hUsd: price?.volume24hUsd ?? null,
    reference: asset.oracle
      ? {
          totalReturnUsd: price?.referenceUsd ?? asset.oracle.priceUsd ?? null,
          updatedAt: price?.referenceUpdatedAt ?? Number(asset.oracle.updatedAt) * 1000,
          isStale: price?.referenceStale ?? asset.oracle.stale,
          isPaused: price?.referencePaused ?? asset.oracle.paused,
        }
      : null,
    displayUsd: price?.displayUsd ?? null,
    displaySource: price?.displaySource ?? "none",
    status: { code: status.status, label: status.label, detail: status.detail },
    totalSupply: asset.totalSupply.toString(),
    transferPaused: asset.transferPaused,
    tags: asset.tags,
    ...(asset.logoURI ? { logoUrl: asset.logoURI } : {}),
  };
}

/** Resolve "NVDA", "nvdac" or a 0x address to one of the listed stocks. */
export function findStock(assets: B20Asset[], idOrSymbol: string): B20Asset | undefined {
  const q = idOrSymbol.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(q)) return assets.find((a) => a.canonicalId === q);
  // Exact ticker first (INTC and COIN end in C); only then read a trailing "c" as the B20 suffix.
  return assets.find((a) => a.underlying.toLowerCase() === q) ?? assets.find((a) => a.underlying.toLowerCase() === q.replace(/c$/, ""));
}

/** Every response carries the same envelope, so a consumer can tell fresh from cached. */
export interface V1Envelope<T> {
  data: T;
  meta: {
    /** Unix ms when this body was built. */
    generatedAt: number;
    /** Seconds this body may be reused; the CDN honours the same number. */
    cacheSeconds: number;
    docs: string;
  };
}

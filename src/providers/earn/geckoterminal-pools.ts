import type { Address } from "viem";
import { estimateFeeApyPct, liquidityRiskLabel } from "./fee-apy";
import { z } from "zod";
import type { EarnOpportunity, EarnProviderId } from "@/domain/earn";
import { cached } from "@/lib/cache";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { gate } from "@/lib/rate-gate";
import { poolSchema, toNum } from "@/providers/market-data/coingecko/schemas";

/**
 * DEX pools for a token as seen by GeckoTerminal (keyless). Complements the factory scans:
 * Uniswap v4 has no per-pool contract (singleton PoolManager), so its pools only show up here.
 * Verified 2026-09-02: GeckoTerminal reserves matched onchain balances within 0.3%.
 * Only DEXes the app knows are mapped to a provider; unknown venues are skipped, never invented.
 */
const BASE_URL = "https://api.geckoterminal.com/api/v2";
const breaker = new CircuitBreaker("geckoterminal.pools", 3, 45_000);
const MIN_RESERVE_USD = 500;

const responseSchema = z.object({ included: z.array(poolSchema).optional() });

const DEX_PROVIDER: Array<{ match: RegExp; provider: EarnProviderId; label: string; url: (pool: string) => string }> = [
  { match: /^uniswap-v4/i, provider: "uniswap", label: "Uniswap v4", url: (pool) => `https://app.uniswap.org/explore/pools/base/${pool}` },
  { match: /^uniswap-v3/i, provider: "uniswap", label: "Uniswap v3", url: (pool) => `https://app.uniswap.org/explore/pools/base/${pool}` },
  { match: /^uniswap/i, provider: "uniswap", label: "Uniswap", url: (pool) => `https://app.uniswap.org/explore/pools/base/${pool}` },
  { match: /^aerodrome-slipstream/i, provider: "aerodrome", label: "Aerodrome Slipstream", url: () => "https://aerodrome.finance/liquidity" },
  { match: /^aerodrome/i, provider: "aerodrome", label: "Aerodrome", url: () => "https://aerodrome.finance/liquidity" },
];

export interface DexPoolInfo {
  address: Address;
  name: string;
  dexId: string;
  /** null for venues the app does not know (listed only when includeUnknown is set). */
  provider: EarnProviderId | null;
  dexLabel: string;
  reserveUsd: number;
  volume24hUsd: number | null;
  url: string | null;
}

export async function getDexPools(asset: Address, opts: { includeUnknown?: boolean } = {}): Promise<DexPoolInfo[]> {
  const all = await cached(`gt:pools:all:${asset.toLowerCase()}`, { ttlMs: 5 * 60_000, staleMs: 30 * 60_000 }, async () => {
    const raw = await breaker.run(async () => {
      await gate("geckoterminal", 2_200);
      const { status, data } = await fetchJson<unknown>(`${BASE_URL}/networks/base/tokens/${asset.toLowerCase()}?include=top_pools`, { headers: { accept: "application/json;version=20230302" }, timeoutMs: 8_000, provider: "geckoterminal" });
      if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "geckoterminal: rate limited", 503);
      if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `geckoterminal: http ${status}`, 502);
      return data;
    });
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      metrics.count("geckoterminal.pools", false, "schema");
      return [];
    }
    const out: DexPoolInfo[] = [];
    for (const p of parsed.data.included ?? []) {
      const dexId = p.relationships?.dex?.data.id ?? "";
      const map = DEX_PROVIDER.find((d) => d.match.test(dexId));
      const reserve = toNum(p.attributes.reserve_in_usd) ?? 0;
      if (reserve < MIN_RESERVE_USD) continue;
      out.push({ address: p.attributes.address as Address, name: p.attributes.name ?? dexId, dexId, provider: map?.provider ?? null, dexLabel: map?.label ?? prettyDex(dexId), reserveUsd: reserve, volume24hUsd: toNum(p.attributes.volume_usd?.h24) ?? null, url: map ? map.url(p.attributes.address) : null });
    }
    return out.sort((a, b) => b.reserveUsd - a.reserveUsd);
  });
  return opts.includeUnknown ? all : all.filter((p) => p.provider !== null);
}

/** "pancakeswap-v3-base" → "Pancakeswap v3" for venues the app has no adapter for. */
function prettyDex(dexId: string): string {
  return dexId.replace(/-base$/i, "").split("-").map((w) => (/^v\d/i.test(w) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ") || "Unknown DEX";
}

/** Pools not already found by the onchain factory scans, as link-out liquidity opportunities. */
export async function discoverDexPoolOpportunities(asset: Address, known: Set<string>): Promise<EarnOpportunity[]> {
  try {
    const pools = await getDexPools(asset);
    const now = Date.now();
    return pools
      .filter((p) => !known.has(p.address.toLowerCase()))
      .filter((p): p is DexPoolInfo & { provider: EarnProviderId; url: string } => p.provider !== null && p.url !== null)
      .map((p) => ({
        id: `${p.provider}:pool:${p.address.toLowerCase()}`,
        provider: p.provider,
        assetAddress: asset,
        type: "liquidity" as const,
        title: `${p.dexLabel} · ${p.name}`,
        liquidityUsd: p.reserveUsd,
        variableApy: estimateFeeApyPct(p.volume24hUsd, feeRateFromName(p.name), p.reserveUsd),
        riskLabel: liquidityRiskLabel(/USDC/i.test(p.name) ? "USDC" : null, p.reserveUsd),
        dataTimestamp: now,
        url: p.url,
        risks: [
          "Variable fees: earnings depend on trading volume and are not guaranteed.",
          "Price / range risk: providing liquidity changes your exposure as prices move (impermanent loss).",
          "Concentrated positions can fall out of range and stop earning.",
          "Pool discovered via GeckoTerminal; confirm the pair and fee tier on the venue before depositing.",
        ],
        inApp: false,
        metadata: { pool: p.address, dexId: p.dexId, volume24hUsd: p.volume24hUsd, source: "geckoterminal" },
      }));
  } catch (err) {
    metrics.count("geckoterminal.pools", false, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** GeckoTerminal encodes the fee tier in the pool name ("… 0.3%"); absent = unknown. */
function feeRateFromName(name: string): number | null {
  const m = /(\d+(?:\.\d+)?)%/.exec(name);
  return m ? Number(m[1]) / 100 : null;
}

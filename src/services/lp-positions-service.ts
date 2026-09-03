import { erc20Abi, type Address } from "viem";
import { cached } from "@/lib/cache";
import { metrics } from "@/lib/http";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { CURATED_B20_ASSETS, canonicalId } from "@/lib/b20/registry";
import { USDC_ADDRESS, USDC_DECIMALS, WETH_ADDRESS } from "@/config/chain";
import { amountsForLiquidity, inRange, sqrtPriceX96ToSqrtPrice, tickToPrice } from "@/lib/earn/lp-math";
import { MAX_UINT128, positionManagerCommonAbi, slipstreamFactoryAbi, slipstreamPoolSlot0Abi, slipstreamPositionsAbi, uniswapV3FactoryAbi, uniswapV3PoolSlot0Abi, uniswapV3PositionsAbi } from "@/lib/earn/abis";
import { getAssets } from "./b20-asset-service";
import { getEthUsd, getPriceViews } from "./price-service";

/**
 * A wallet's concentrated-liquidity positions that involve a tokenized stock. Reads only; the
 * manage actions (collect, decreaseLiquidity) are built client-side against the same managers. Verified on Base
 * mainnet 2026-09-02: Uniswap v3 NPM 0x03a5…34f1 (factory 0x3312…FDfD); Aerodrome Slipstream NPM
 * 0xe1f8…8b53 (current factory 0xf8f2…61Ef, 4k+ mints on the NVDAc/USDC pool) and the legacy NPM
 * 0x8279…5b72 (factory 0x5e7B…809A).
 */
import { LP_MANAGER_INFO, type LpManagerInfo } from "@/lib/earn/lp-managers";

export interface LpManager extends LpManagerInfo {
  manageUrl: (tokenId: bigint) => string;
}

const MANAGE_URL: Record<LpManagerInfo["id"], (tokenId: bigint) => string> = {
  "aerodrome-cl": () => "https://aerodrome.finance/dash",
  "aerodrome-cl-legacy": () => "https://aerodrome.finance/dash",
  "uniswap-v3": (id) => `https://app.uniswap.org/positions/v3/base/${id.toString()}`,
};

export const LP_MANAGERS: LpManager[] = LP_MANAGER_INFO.map((m) => ({ ...m, manageUrl: MANAGE_URL[m.id] }));

export interface LpPosition {
  manager: LpManager["id"];
  managerLabel: string;
  provider: "uniswap" | "aerodrome";
  tokenId: string;
  pool: Address;
  token0: { address: Address; symbol: string; decimals: number };
  token1: { address: Address; symbol: string; decimals: number };
  /** Fee tier (v3, in hundredths of a bip) or tick spacing (Slipstream). */
  feeOrTickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  /** Raw position liquidity, needed to build a decreaseLiquidity call. */
  liquidity: string;
  /** Range expressed as USD per one stock token (when a B20 token is in the pair and priced). */
  rangeUsd: { lower: number; upper: number; current: number } | null;
  amount0: number;
  amount1: number;
  valueUsd: number | null;
  fees: { amount0: number; amount1: number; usd: number | null };
  manageUrl: string;
}

const MAX_POSITIONS_PER_MANAGER = 40;

interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  priceUsd: number | null;
  isStock: boolean;
}

export async function getLpPositions(owner: Address): Promise<LpPosition[]> {
  return cached(`lp:positions:${owner.toLowerCase()}`, { ttlMs: 30_000, staleMs: 5 * 60_000 }, async () => {
    const client = getServerPublicClient();
    const assets = await getAssets();
    const [views, ethUsd] = await Promise.all([getPriceViews(assets), getEthUsd().catch(() => null)]);
    const tokenInfo = new Map<string, TokenInfo>();
    for (const a of assets) tokenInfo.set(a.canonicalId, { address: a.address, symbol: a.underlying, decimals: a.decimals, priceUsd: views.get(a.canonicalId)?.displayUsd ?? null, isStock: true });
    tokenInfo.set(USDC_ADDRESS.toLowerCase(), { address: USDC_ADDRESS, symbol: "USDC", decimals: USDC_DECIMALS, priceUsd: 1, isStock: false });
    tokenInfo.set(WETH_ADDRESS.toLowerCase(), { address: WETH_ADDRESS, symbol: "WETH", decimals: 18, priceUsd: ethUsd, isStock: false });
    const stockAddresses = new Set(CURATED_B20_ASSETS.map((a) => canonicalId(a.address)));

    const out: LpPosition[] = [];
    for (const m of LP_MANAGERS) {
      try {
        const count = await client.readContract({ address: m.npm, abi: positionManagerCommonAbi, functionName: "balanceOf", args: [owner] });
        const n = Number(count > BigInt(MAX_POSITIONS_PER_MANAGER) ? BigInt(MAX_POSITIONS_PER_MANAGER) : count);
        if (n === 0) continue;
        const idRes = await client.multicall({ contracts: Array.from({ length: n }, (_, i) => ({ address: m.npm, abi: positionManagerCommonAbi, functionName: "tokenOfOwnerByIndex" as const, args: [owner, BigInt(i)] as const })), allowFailure: true });
        const ids = idRes.filter((r) => r.status === "success").map((r) => r.result as bigint);
        if (ids.length === 0) continue;
        const posAbi = m.kind === "v3" ? uniswapV3PositionsAbi : slipstreamPositionsAbi;
        const posRes = await client.multicall({ contracts: ids.map((id) => ({ address: m.npm, abi: posAbi, functionName: "positions" as const, args: [id] as const })), allowFailure: true });
        type Pos = readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
        const candidates = ids
          .map((id, i) => ({ id, p: posRes[i]?.status === "success" ? (posRes[i]!.result as unknown as Pos) : null }))
          .filter((x): x is { id: bigint; p: Pos } => !!x.p)
          .filter(({ p }) => (stockAddresses.has(p[2].toLowerCase()) || stockAddresses.has(p[3].toLowerCase())) && (p[7] > 0n || p[10] > 0n || p[11] > 0n));
        if (candidates.length === 0) continue;

        // Unknown tokens (rare): read symbol/decimals on the fly so nothing is mislabelled.
        const unknown = Array.from(new Set(candidates.flatMap(({ p }) => [p[2], p[3]]).map((a) => a.toLowerCase()).filter((a) => !tokenInfo.has(a))));
        if (unknown.length > 0) {
          const meta = await client.multicall({ contracts: unknown.flatMap((a) => [{ address: a as Address, abi: erc20Abi, functionName: "symbol" as const }, { address: a as Address, abi: erc20Abi, functionName: "decimals" as const }]), allowFailure: true });
          unknown.forEach((a, i) => tokenInfo.set(a, { address: a as Address, symbol: meta[i * 2]?.status === "success" ? String(meta[i * 2]!.result) : "?", decimals: meta[i * 2 + 1]?.status === "success" ? Number(meta[i * 2 + 1]!.result) : 18, priceUsd: null, isStock: false }));
        }

        const factoryAbi = m.kind === "v3" ? uniswapV3FactoryAbi : slipstreamFactoryAbi;
        const poolRes = await client.multicall({ contracts: candidates.map(({ p }) => ({ address: m.factory, abi: factoryAbi, functionName: "getPool" as const, args: [p[2], p[3], p[4]] as const })), allowFailure: true });
        const pools = poolRes.map((r) => (r.status === "success" ? (r.result as Address) : null));
        const slotAbi = m.kind === "v3" ? uniswapV3PoolSlot0Abi : slipstreamPoolSlot0Abi;
        const slotRes = await client.multicall({ contracts: pools.map((pool) => ({ address: pool ?? m.factory, abi: slotAbi, functionName: "slot0" as const })), allowFailure: true });
        const feeRes = await Promise.all(
          candidates.map(({ id }) =>
            client
              .simulateContract({ address: m.npm, abi: positionManagerCommonAbi, functionName: "collect", args: [{ tokenId: id, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }], account: owner })
              .then((r) => r.result as readonly [bigint, bigint])
              .catch(() => null),
          ),
        );

        candidates.forEach(({ id, p }, i) => {
          const pool = pools[i];
          const slot = slotRes[i]?.status === "success" ? (slotRes[i]!.result as unknown as readonly [bigint, number]) : null;
          if (!pool || !slot) return;
          const t0 = tokenInfo.get(p[2].toLowerCase())!;
          const t1 = tokenInfo.get(p[3].toLowerCase())!;
          const sqrtPrice = sqrtPriceX96ToSqrtPrice(slot[0]);
          const tick = Number(slot[1]);
          const raw = amountsForLiquidity(p[7], sqrtPrice, Number(p[5]), Number(p[6]));
          const amount0 = raw.amount0 / 10 ** t0.decimals;
          const amount1 = raw.amount1 / 10 ** t1.decimals;
          const valueUsd = t0.priceUsd !== null && t1.priceUsd !== null ? amount0 * t0.priceUsd + amount1 * t1.priceUsd : null;
          const fees = feeRes[i];
          const fee0 = fees ? Number(fees[0]) / 10 ** t0.decimals : Number(p[10]) / 10 ** t0.decimals;
          const fee1 = fees ? Number(fees[1]) / 10 ** t1.decimals : Number(p[11]) / 10 ** t1.decimals;
          const feesUsd = t0.priceUsd !== null && t1.priceUsd !== null ? fee0 * t0.priceUsd + fee1 * t1.priceUsd : null;
          // Range in USD per stock token: price(token0 in token1) converted with the quote token's USD price.
          let rangeUsd: LpPosition["rangeUsd"] = null;
          const stockIs0 = t0.isStock;
          const quote = stockIs0 ? t1 : t0;
          if ((t0.isStock || t1.isStock) && quote.priceUsd !== null) {
            const conv = (tk: number) => {
              const p01 = tickToPrice(tk, t0.decimals, t1.decimals); // token1 per token0
              return stockIs0 ? p01 * quote.priceUsd! : (1 / p01) * quote.priceUsd!;
            };
            const lower = conv(Number(p[5]));
            const upper = conv(Number(p[6]));
            rangeUsd = { lower: Math.min(lower, upper), upper: Math.max(lower, upper), current: conv(tick) };
          }
          out.push({
            manager: m.id,
            managerLabel: m.label,
            provider: m.provider,
            tokenId: id.toString(),
            pool,
            token0: { address: t0.address, symbol: t0.symbol, decimals: t0.decimals },
            token1: { address: t1.address, symbol: t1.symbol, decimals: t1.decimals },
            feeOrTickSpacing: Number(p[4]),
            liquidity: p[7].toString(),
            tickLower: Number(p[5]),
            tickUpper: Number(p[6]),
            currentTick: tick,
            inRange: inRange(tick, Number(p[5]), Number(p[6])),
            rangeUsd,
            amount0,
            amount1,
            valueUsd,
            fees: { amount0: fee0, amount1: fee1, usd: feesUsd },
            manageUrl: m.manageUrl(id),
          });
        });
      } catch (err) {
        metrics.count(`lp.${m.id}`, false, err instanceof Error ? err.message : String(err));
      }
    }
    return out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  });
}

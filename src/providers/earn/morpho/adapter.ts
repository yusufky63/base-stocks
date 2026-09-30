import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { z } from "zod";
import { erc4626Abi } from "@/lib/earn/abis";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { serverEnv } from "@/config/env";
import { BASE_CHAIN_ID } from "@/config/chain";
import type { EarnExecution, EarnIntent, EarnOpportunity, EarnProvider } from "@/domain/earn";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { AppError } from "@/lib/errors";

/**
 * Morpho runtime discovery via the public GraphQL API (https://api.morpho.org/graphql).
 * Market availability is DISCOVERED. Nothing is assumed for any B20 asset.
 * Transaction construction (Phase 8b) should use @morpho-org/morpho-sdk; V1 links out.
 */
const breaker = new CircuitBreaker("morpho", 3, 30_000);

const vaultsSchema = z.object({
  data: z
    .object({
      vaults: z.object({
        items: z.array(
          z.object({
            address: z.string(),
            name: z.string().nullable().optional(),
            symbol: z.string().nullable().optional(),
            listed: z.boolean().nullable().optional(),
            /** What is withdrawable right now, which is not the same as what is deposited. */
            liquidity: z.object({ usd: z.number().nullable().optional() }).nullable().optional(),
            /** Morpho's own flags: deposit_disabled, short_timelock, low_liquidity, not_whitelisted, deprecated… */
            warnings: z.array(z.object({ type: z.string(), level: z.string().nullable().optional() })).nullable().optional(),
            asset: z.object({ address: z.string(), symbol: z.string().nullable().optional() }).nullable().optional(),
            chain: z.object({ id: z.number() }).nullable().optional(),
            state: z
              .object({
                apy: z.number().nullable().optional(),
                netApy: z.number().nullable().optional(),
                netApyExcludingRewards: z.number().nullable().optional(),
                totalAssetsUsd: z.number().nullable().optional(),
                timestamp: z.union([z.number(), z.string()]).nullable().optional(),
                fee: z.number().nullable().optional(),
                allRewards: z.array(z.object({ supplyApr: z.number().nullable().optional(), asset: z.object({ symbol: z.string().nullable().optional() }).nullable().optional() })).nullable().optional(),
              })
              .nullable()
              .optional(),
          }),
        ),
      }),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/** `allRewards` includes campaigns forwarded from underlying markets (Merkl); `rewards` is deprecated (removal 2026-09-30). */
const QUERY = `query VaultsForAsset($chainIds: [Int!], $assets: [String!]) {
  vaults(first: 20, where: { chainId_in: $chainIds, assetAddress_in: $assets }, orderBy: TotalAssetsUsd, orderDirection: Desc) {
    items { address name symbol listed liquidity { usd } warnings { type level } asset { address symbol } chain { id } state { apy netApy netApyExcludingRewards totalAssetsUsd timestamp fee allRewards { supplyApr asset { symbol } } } }
  }
}`;

/** Morpho Blue markets that accept the asset as COLLATERAL (borrow against a stock). Field names verified via introspection (2026-09). */
const MARKETS_QUERY = `query MarketsForCollateral($chainIds: [Int!], $collateral: [String!]) {
  markets(first: 10, where: { chainId_in: $chainIds, collateralAssetAddress_in: $collateral }) {
    items { marketId listed lltv loanAsset { address symbol } collateralAsset { address symbol } state { borrowApy liquidityAssetsUsd supplyAssetsUsd timestamp } }
  }
}`;

const marketsSchema = z.object({
  data: z
    .object({
      markets: z.object({
        items: z.array(
          z.object({
            marketId: z.string(),
            listed: z.boolean().nullable().optional(),
            lltv: z.union([z.string(), z.number()]).nullable().optional(),
            loanAsset: z.object({ address: z.string(), symbol: z.string().nullable().optional() }).nullable().optional(),
            collateralAsset: z.object({ address: z.string(), symbol: z.string().nullable().optional() }).nullable().optional(),
            state: z
              .object({
                borrowApy: z.number().nullable().optional(),
                liquidityAssetsUsd: z.number().nullable().optional(),
                supplyAssetsUsd: z.number().nullable().optional(),
                timestamp: z.union([z.number(), z.string()]).nullable().optional(),
              })
              .nullable()
              .optional(),
          }),
        ),
      }),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

type MorphoMarket = NonNullable<z.infer<typeof marketsSchema>["data"]>["markets"]["items"][number];

/** Free liquidity at which a market counts as deep; below it the market is shown as thin, listed or not. */
const DEEP_BORROW_LIQUIDITY_USD = 10_000;
/**
 * What lenders must have supplied before an unlisted market is shown at all: what separates a
 * market people use from a $3 test market. Well-used lending markets keep little free liquidity
 * by design (the stock markets on Base ran at about 90% utilization in September 2026).
 */
const MIN_BORROW_SUPPLY_USD = 1_000;
/**
 * Below this there is nothing to borrow at all, and the market is hidden even when Morpho lists it:
 * in September 2026 several listed stock markets had no lenders yet and read "$0 free".
 */
const MIN_FREE_LIQUIDITY_USD = 100;

export interface BorrowMarketView {
  market: MorphoMarket;
  /** Less than a deep market's free liquidity: shown, with the reason spelled out. */
  thin: boolean;
  /** Share of supplied assets already lent out, 0..1, when the API reports both sides. */
  utilization: number | null;
}

/**
 * Which Morpho markets for this collateral are worth showing: something left to borrow, and either
 * Morpho's listing or real supply behind it. Thin below a deep market's free liquidity. Deepest
 * supply first, so the market most people use leads.
 */
export function selectBorrowMarkets(items: MorphoMarket[], asset: Address): BorrowMarketView[] {
  return items
    .filter((m) => m.collateralAsset?.address?.toLowerCase() === asset.toLowerCase())
    .map((m) => {
      const free = m.state?.liquidityAssetsUsd ?? 0;
      const supplied = m.state?.supplyAssetsUsd ?? 0;
      const listed = m.listed ?? false;
      const room = free >= MIN_FREE_LIQUIDITY_USD;
      const utilization = supplied > 0 ? Math.min(1, Math.max(0, 1 - free / supplied)) : null;
      return { market: m, show: room && (listed || supplied >= MIN_BORROW_SUPPLY_USD), thin: free < DEEP_BORROW_LIQUIDITY_USD, utilization };
    })
    .filter((v) => v.show)
    .sort((a, b) => (b.market.state?.supplyAssetsUsd ?? 0) - (a.market.state?.supplyAssetsUsd ?? 0))
    .map(({ market, thin, utilization }) => ({ market, thin, utilization }));
}

function compactUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export class MorphoEarnProvider implements EarnProvider {
  readonly id = "morpho" as const;

  async discover(asset: Address): Promise<EarnOpportunity[]> {
    const [vaults, borrow] = await Promise.all([this.discoverVaults(asset), this.discoverBorrow(asset)]);
    return [...vaults, ...borrow];
  }

  /** "Borrow USDC against your stock": every Morpho market for that collateral that people actually use (see `selectBorrowMarkets`). */
  private async discoverBorrow(asset: Address): Promise<EarnOpportunity[]> {
    const env = serverEnv();
    try {
      const raw = await breaker.run(async () => {
        const { status, data } = await fetchJson<unknown>(env.MORPHO_API_URL, {
          method: "POST",
          body: { query: MARKETS_QUERY, variables: { chainIds: [BASE_CHAIN_ID], collateral: [asset] } },
          timeoutMs: 6_000,
          provider: "morpho",
        });
        if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `morpho: http ${status}`, 502);
        return data;
      });
      const parsed = marketsSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.data) {
        metrics.count("morpho.markets", false, parsed.success ? parsed.data.errors?.[0]?.message : "schema");
        return [];
      }
      const now = Date.now();
      return selectBorrowMarkets(parsed.data.data.markets.items, asset).map(({ market: m, thin, utilization }) => {
        const ts = m.state?.timestamp;
        const dataTimestamp = ts ? Number(ts) * (Number(ts) < 1e12 ? 1000 : 1) : now;
        const lltvPct = m.lltv !== null && m.lltv !== undefined ? (Number(m.lltv) / 1e18) * 100 : null;
        const loan = m.loanAsset?.symbol ?? "USDC";
        return {
          id: `morpho:market:${m.marketId.toLowerCase()}`,
          provider: "morpho" as const,
          assetAddress: asset,
          type: "borrow" as const,
          title: `Borrow ${loan} against ${m.collateralAsset?.symbol?.replace(/c$/, "") ?? "this stock"}${lltvPct !== null ? ` · up to ${lltvPct.toFixed(0)}% LTV` : ""}`,
          variableApy: m.state?.borrowApy !== null && m.state?.borrowApy !== undefined ? m.state.borrowApy * 100 : undefined,
          liquidityUsd: m.state?.liquidityAssetsUsd ?? undefined,
          tvlUsd: m.state?.supplyAssetsUsd ?? undefined,
          riskLabel: "higher" as const,
          dataTimestamp,
          url: `https://app.morpho.org/base/market/${m.marketId}`,
          risks: [
            ...(thin
              ? [
                  `Thin market: about ${compactUsd(m.state?.liquidityAssetsUsd ?? 0)} is free to borrow right now${utilization !== null ? ` and ${Math.round(utilization * 100)}% of what lenders supplied is already lent out` : ""}, so a larger loan waits for new supply and the rate can jump as the rest is borrowed.`,
                ]
              : []),
            "Liquidation risk: if the stock price falls and your loan exceeds the liquidation LTV, collateral is sold.",
            "Variable borrow rate: interest accrues every block and can rise with utilization.",
            "Oracle risk: the market prices collateral through its own oracle, which can lag or pause.",
            "The stock token stays subject to issuer policies while held as collateral.",
          ],
          inApp: false,
          metadata: { marketId: m.marketId, lltv: m.lltv ?? null, loanAsset: m.loanAsset?.address ?? null, listed: m.listed ?? false, liquidityUsd: m.state?.liquidityAssetsUsd ?? null, suppliedUsd: m.state?.supplyAssetsUsd ?? null, utilization, thin },
        };
      });
    } catch (err) {
      metrics.count("morpho.markets", false, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  private async discoverVaults(asset: Address): Promise<EarnOpportunity[]> {
    const env = serverEnv();
    try {
      const raw = await breaker.run(async () => {
        const { status, data } = await fetchJson<unknown>(env.MORPHO_API_URL, {
          method: "POST",
          body: { query: QUERY, variables: { chainIds: [BASE_CHAIN_ID], assets: [asset] } },
          timeoutMs: 6_000,
          provider: "morpho",
        });
        if (status >= 400) throw new AppError("PROVIDER_UNAVAILABLE", `morpho: http ${status}`, 502);
        return data;
      });
      const parsed = vaultsSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.data) {
        metrics.count("morpho.discover", false, parsed.success ? parsed.data.errors?.[0]?.message : "schema");
        return [];
      }
      const now = Date.now();
      return parsed.data.data.vaults.items
        .filter((v) => (v.chain?.id ?? BASE_CHAIN_ID) === BASE_CHAIN_ID && v.asset?.address?.toLowerCase() === asset.toLowerCase())
        .map((v) => {
          const ts = v.state?.timestamp;
          const dataTimestamp = ts ? Number(ts) * (Number(ts) < 1e12 ? 1000 : 1) : now;
          const apy = v.state?.netApy ?? v.state?.apy ?? undefined;
          const rewardsApr = (v.state?.allRewards ?? []).reduce((s, r) => s + (r.supplyApr ?? 0), 0);
          const rewardSymbols = (v.state?.allRewards ?? []).map((r) => r.asset?.symbol).filter((x): x is string => !!x);
          return {
            id: `morpho:vault:${v.address.toLowerCase()}`,
            provider: "morpho" as const,
            assetAddress: asset,
            type: "vault" as const,
            title: v.name ?? v.symbol ?? "Morpho Vault",
            variableApy: apy !== undefined && apy !== null ? apy * 100 : undefined,
            rewardsApr: rewardsApr > 0 ? rewardsApr * 100 : undefined,
            tvlUsd: v.state?.totalAssetsUsd ?? undefined,
            riskLabel: v.listed ? "medium" : "unknown",
            dataTimestamp,
            url: `https://app.morpho.org/base/vault/${v.address}`,
            risks: [
              "Variable rate: the displayed APY is an estimate from recent activity and is not guaranteed.",
              "Vault curator and market risk: deposits are allocated to onchain lending markets chosen by the vault curator.",
              "Withdrawals depend on available liquidity in the vault's markets.",
            ],
            inApp: true,
            metadata: {
              vault: v.address,
              listed: v.listed ?? false,
              symbol: v.symbol ?? null,
              performanceFee: v.state?.fee ?? null,
              rewardSymbols,
              netApyExcludingRewards: v.state?.netApyExcludingRewards ?? null,
              // The two things Morpho's own interface warns about, kept as data rather than prose.
              warnings: (v.warnings ?? []).map((w) => ({ type: w.type, level: (w.level ?? "").toUpperCase() })),
              withdrawableUsd: v.liquidity?.usd ?? null,
            },
          };
        });
    } catch (err) {
      metrics.count("morpho.discover", false, err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Morpho vaults are ERC-4626: deposit = approve(vault) + deposit(assets, receiver);
   * withdraw = withdraw(assets, receiver, owner) or redeem(all shares) for "max".
   */
  async prepare(input: EarnIntent): Promise<EarnExecution> {
    const vault = input.opportunityId.replace(/^morpho:vault:/, "") as Address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new AppError("BAD_REQUEST", "Unknown Morpho vault", 400);
    const client = getServerPublicClient();
    const [underlying, shares] = await Promise.all([
      client.readContract({ address: vault, abi: erc4626Abi, functionName: "asset" }),
      client.readContract({ address: vault, abi: erc4626Abi, functionName: "balanceOf", args: [input.user] }),
    ]);
    const decimals = await client.readContract({ address: underlying, abi: erc20Abi, functionName: "decimals" });
    if (input.action === "deposit") {
      if (input.amount === "max" || input.amount <= 0n) throw new AppError("BAD_REQUEST", "Enter a deposit amount.", 400);
      return {
        spender: vault,
        underlying,
        underlyingDecimals: decimals,
        description: `Deposit into Morpho vault ${vault.slice(0, 8)}…`,
        calls: [
          { kind: "approve", to: underlying, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, input.amount] }), value: 0n },
          { kind: "deposit", to: vault, data: encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [input.amount, input.user] }), value: 0n },
        ],
      };
    }
    const data =
      input.amount === "max"
        ? encodeFunctionData({ abi: erc4626Abi, functionName: "redeem", args: [shares, input.user, input.user] })
        : encodeFunctionData({ abi: erc4626Abi, functionName: "withdraw", args: [input.amount, input.user, input.user] });
    return { underlying, underlyingDecimals: decimals, description: `Withdraw from Morpho vault ${vault.slice(0, 8)}…`, calls: [{ kind: "withdraw", to: vault, data, value: 0n }] };
  }
}

export const morphoProvider = new MorphoEarnProvider();

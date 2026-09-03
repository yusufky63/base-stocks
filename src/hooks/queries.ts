"use client";

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type { Address, Hash } from "viem";
import {
  apiGet,
  apiPost,
  apiDelete,
  type AssetsResponse,
  type AssetResponse,
  type ChartResponse,
  type ConfigResponse,
  type EarnResponse,
  type ReverseResponse,
  type ResolveResponse,
  type TxStatusResponse,
  type PortfolioSnapshot,
  type PortfolioTemplate,
  type ActivityItem,
  type PortfolioExecution,
  type GiftRecord,
  type AnnouncementsResponse,
  type RegionResponse,
  type LpPositionDTO,
} from "@/lib/client-api";
import type { Timeframe } from "@/domain/market";
import type { OrderView } from "@/domain/trade";
import type { CommunityPulse } from "@/domain/community";

export const qk = {
  config: ["config"] as const,
  assets: ["assets"] as const,
  asset: (a: string) => ["asset", a.toLowerCase()] as const,
  chart: (a: string, tf: Timeframe) => ["chart", a.toLowerCase(), tf] as const,
  portfolio: (o: string) => ["portfolio", o.toLowerCase()] as const,
  templates: ["templates"] as const,
  earn: (a: string, u?: string) => ["earn", a.toLowerCase(), u?.toLowerCase() ?? ""] as const,
  basename: (a: string) => ["basename", a.toLowerCase()] as const,
  resolve: (i: string) => ["resolve", i.trim().toLowerCase()] as const,
  activity: (o: string) => ["activity", o.toLowerCase()] as const,
  tx: (h: string) => ["tx", h.toLowerCase()] as const,
  order: (uid: string) => ["order", uid.toLowerCase()] as const,
  orders: (o: string) => ["orders", o.toLowerCase()] as const,
  watchlist: (o: string) => ["watchlist", o.toLowerCase()] as const,
  executions: (o: string) => ["executions", o.toLowerCase()] as const,
  gifts: (o: string) => ["gifts", o.toLowerCase()] as const,
  region: ["region"] as const,
  lp: (o: string) => ["earn", "lp", o.toLowerCase()] as const,
};

export function useSparklines() {
  return useQuery({
    queryKey: ["sparklines"],
    queryFn: () => apiGet<{ series: Record<string, number[]>; updatedAt: number }>("/api/sparklines"),
    staleTime: 5 * 60_000,
  });
}

export function useAnnouncements(address: string) {
  return useQuery({
    queryKey: ["announcements", address.toLowerCase()],
    queryFn: () => apiGet<AnnouncementsResponse>(`/api/assets/${address}/announcements`),
    staleTime: 5 * 60_000,
    enabled: !!address,
  });
}

export function useConfigFlags() {
  return useQuery({ queryKey: qk.config, queryFn: () => apiGet<ConfigResponse>("/api/config"), staleTime: 5 * 60_000 });
}

export function useAssets(initialData?: AssetsResponse) {
  return useQuery({
    queryKey: qk.assets,
    queryFn: () => apiGet<AssetsResponse>("/api/assets"),
    initialData,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useAsset(address: string, initialData?: AssetResponse) {
  return useQuery({
    queryKey: qk.asset(address),
    queryFn: () => apiGet<AssetResponse>(`/api/assets/${address}`),
    initialData,
    refetchInterval: 20_000,
    enabled: !!address,
  });
}

export function useChart(address: string, timeframe: Timeframe) {
  return useQuery({
    queryKey: qk.chart(address, timeframe),
    queryFn: () => apiGet<ChartResponse>(`/api/market/${address}/ohlcv?timeframe=${timeframe}`),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    enabled: !!address,
  });
}

export function usePortfolio(owner?: Address) {
  return useQuery({
    queryKey: qk.portfolio(owner ?? ""),
    queryFn: () => apiGet<PortfolioSnapshot>(`/api/portfolio/${owner}`),
    enabled: !!owner,
    refetchInterval: 30_000,
  });
}

export function useTemplates(initialData?: PortfolioTemplate[]) {
  return useQuery({
    queryKey: qk.templates,
    queryFn: async () => (await apiGet<{ templates: PortfolioTemplate[] }>("/api/templates")).templates,
    initialData,
    staleTime: 5 * 60_000,
  });
}

export function useEarn(address: string, user?: Address) {
  return useQuery({
    queryKey: qk.earn(address, user),
    queryFn: () => apiGet<EarnResponse>(`/api/earn/${address}${user ? `?user=${user}` : ""}`),
    staleTime: 2 * 60_000,
    enabled: !!address,
  });
}

export function useBasename(address?: Address) {
  return useQuery({
    queryKey: qk.basename(address ?? ""),
    queryFn: () => apiGet<ReverseResponse>(`/api/basename/reverse?address=${address}`),
    enabled: !!address,
    staleTime: 10 * 60_000,
  });
}

export function useResolveRecipient(input: string) {
  const v = input.trim();
  return useQuery({
    queryKey: qk.resolve(v),
    queryFn: () => apiGet<ResolveResponse>(`/api/basename/resolve?name=${encodeURIComponent(v)}`),
    enabled: v.length >= 3,
    staleTime: 60_000,
  });
}

export function useActivity(owner?: Address) {
  return useQuery({
    queryKey: qk.activity(owner ?? ""),
    queryFn: async () => (await apiGet<{ items: ActivityItem[] }>(`/api/activity/${owner}`)).items,
    enabled: !!owner,
    refetchInterval: 120_000,
  });
}

export function useExecutions(owner?: Address) {
  return useQuery({
    queryKey: qk.executions(owner ?? ""),
    queryFn: async () => (await apiGet<{ executions: PortfolioExecution[] }>(`/api/portfolio/executions?owner=${owner}`)).executions,
    enabled: !!owner,
  });
}

export function useGifts(owner?: Address) {
  return useQuery({
    queryKey: qk.gifts(owner ?? ""),
    queryFn: async () => (await apiGet<{ gifts: GiftRecord[] }>(`/api/gifts?owner=${owner}`)).gifts,
    enabled: !!owner,
  });
}

/** Poll transaction status until terminal (Submitted → Preconfirmed → Confirmed). */
/** One signed order, polled while it is open (CoW solvers usually fill within a minute). */
export function useOrderStatus(uid?: string) {
  return useQuery({
    queryKey: qk.order(uid ?? ""),
    queryFn: () => apiGet<{ order: OrderView }>(`/api/trade/orders/${uid}`).then((r) => r.order),
    enabled: !!uid,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "open" || s === "presignaturePending" || s === undefined ? 3_000 : false;
    },
  });
}

/** The wallet's recent orders; refreshed while any is still open. */
export function useOrders(owner?: Address) {
  return useQuery({
    queryKey: qk.orders(owner ?? ""),
    queryFn: () => apiGet<{ orders: OrderView[] }>(`/api/trade/orders?owner=${owner}&limit=50`).then((r) => r.orders),
    enabled: !!owner,
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.some((o) => o.status === "open") ? 8_000 : 60_000),
  });
}

/** Anonymous 7-day community aggregates for the home module. */
export function useCommunityPulse() {
  return useQuery({
    queryKey: ["community", "pulse"],
    queryFn: () => apiGet<CommunityPulse>("/api/community/pulse"),
    staleTime: 60_000,
  });
}

export function useTxStatus(hash?: Hash) {
  return useQuery({
    queryKey: qk.tx(hash ?? ""),
    queryFn: () => apiGet<TxStatusResponse>(`/api/tx/${hash}`),
    enabled: !!hash,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "confirmed" || s === "failed" ? false : 1_200;
    },
  });
}

export function useWatchlist(owner?: Address) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: qk.watchlist(owner ?? ""),
    queryFn: async () => (await apiGet<{ assets: Address[] }>(`/api/watchlist?owner=${owner}`)).assets,
    enabled: !!owner,
    staleTime: 60_000,
  });
  const add = useMutation({
    mutationFn: (assetAddress: Address) => apiPost("/api/watchlist", { owner, assetAddress }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.watchlist(owner ?? "") }),
  });
  const remove = useMutation({
    mutationFn: (assetAddress: Address) => apiDelete("/api/watchlist", { owner, assetAddress }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.watchlist(owner ?? "") }),
  });
  const set = new Set((list.data ?? []).map((a) => a.toLowerCase()));
  return {
    assets: list.data ?? [],
    has: (a: string) => set.has(a.toLowerCase()),
    toggle: (a: Address) => (set.has(a.toLowerCase()) ? remove.mutate(a) : add.mutate(a)),
    isLoading: list.isLoading,
  };
}

/** Visitor region as the host reports it; decides whether trade actions are shown at all. */
export function useRegion() {
  return useQuery({ queryKey: qk.region, queryFn: () => apiGet<RegionResponse>("/api/region"), staleTime: Infinity, gcTime: Infinity, retry: 1 });
}

/** Concentrated-liquidity positions (Uniswap v3, Aerodrome Slipstream) that include a tokenized stock. */
export function useLpPositions(owner?: Address) {
  return useQuery({
    queryKey: qk.lp(owner ?? ""),
    queryFn: () => apiGet<{ positions: LpPositionDTO[]; readAt: number }>(`/api/earn/lp?user=${owner}`),
    enabled: !!owner,
    staleTime: 30_000,
  });
}

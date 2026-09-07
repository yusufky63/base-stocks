import type { Address } from "viem";

/**
 * The console's shared client: one authenticated fetch and the shapes the admin routes answer with.
 *
 * The token lives in `sessionStorage` and travels only as the `x-admin-token` header — never in a
 * URL, never in `localStorage`, so closing the tab ends the session.
 */
export async function adminFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", "x-admin-token": token, ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export interface HealthResponse {
  storage: { backend: string; tablesReady: boolean | null; missing: string[] };
  auth: { persistentSessions: boolean };
  deploy: { commit: string | null; region: string | null; serverless: boolean };
  keeper: { address: string; eth: string | null } | null;
  errors: { lastHour: number };
  alerts: string[];
  schemaMissingSeen: string[];
  providers?: Record<string, { calls: number; errors: number; avgLatencyMs: number; breakerOpens: number; lastError?: string }>;
  time: number;
}

export interface AdminError {
  fingerprint: string;
  source: string;
  route?: string;
  message: string;
  stack?: string;
  digest?: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface OverviewResponse {
  index: { cursor: number | null; head: number; lag: number; lagSeconds: number; wallets: number } | { error: string };
  ai: { today: number; limits: { perIpPerDay: number; perWalletPerDay: number; globalPerDay: number; perIpPerMinute: number }; spendUsd: number; budgetUsd: number } | null;
  tables: Record<string, number | null>;
  automation: { autoRules: number; onchainPlans: number; maxRunsPerTick: number; keeperConfigured: boolean; contract: string | null };
  capabilities: Record<string, boolean>;
  settings: { geoblockMode: string; geoblockCountries: string; integratorFeeBps: number; oracleStalenessSeconds: number; backend: string; nodeEnv: string };
  time: number;
}

export interface JobRun {
  ok: boolean;
  job: string;
  ms: number;
  result?: unknown;
  error?: string;
}

export interface Discovered {
  address: Address;
  name: string;
  symbol: string;
  blockNumber: number;
  verification: "discovered" | "verified" | "disabled";
  underlying?: string;
  chainlinkFeed?: string;
  eligible?: boolean;
  autoVerified?: boolean;
  reason?: string;
  creator?: string;
  updatedAt: number;
}

/** UTC everywhere in the console: a server's clock, not the reader's. */
export function utc(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/** "4 min", "2 h 10 min" — a duration a person reads without doing arithmetic. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const h = Math.floor(seconds / 3600);
  return `${h} h ${Math.round((seconds - h * 3600) / 60)} min`;
}

import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "@/db/supabase";
import { metrics } from "@/lib/http";
import { secretEquals } from "@/lib/api";
import { clientIp, hashIp } from "@/lib/rate-limit";

/** One definition of "who is calling" for every limiter; re-exported so existing imports keep working. */
export { clientIp, hashIp };

/**
 * Hard spending guard for the AI helper: per-IP, per-wallet and global daily caps plus a
 * short per-IP burst limit. Counters persist in Supabase (`ai_usage`) when configured and
 * fall back to in-memory otherwise.
 */
export interface QuotaLimits {
  perIpPerDay: number;
  perWalletPerDay: number;
  globalPerDay: number;
  perIpPerMinute: number;
  /** A trusted service (the Telegram bot) relays many end users from one IP: each gets this many a day. */
  perServiceUserPerDay: number;
  /** And the service as a whole gets this many, so a compromised token cannot drain the global cap alone. */
  perServicePerDay: number;
}

export function quotaLimitsFromEnv(): QuotaLimits {
  const n = (k: string, d: number) => {
    const v = Number(process.env[k]);
    return Number.isInteger(v) && v >= 0 ? v : d;
  };
  return {
    perIpPerDay: n("AI_DAILY_LIMIT_PER_IP", 40),
    perWalletPerDay: n("AI_DAILY_LIMIT_PER_WALLET", 25),
    globalPerDay: n("AI_GLOBAL_DAILY_LIMIT", 500),
    perIpPerMinute: n("AI_BURST_LIMIT_PER_IP", 5),
    perServiceUserPerDay: n("AI_DAILY_LIMIT_PER_SERVICE_USER", 40),
    perServicePerDay: n("AI_DAILY_LIMIT_PER_SERVICE", 400),
  };
}

/**
 * A service identity for the assistant: a server-to-server caller (the Telegram bot) that proves
 * itself with `ASSISTANT_SERVICE_TOKEN` and names the end user it is relaying. Its quota is then
 * keyed on that end user, not on the bot's one IP, which would otherwise be exhausted by the
 * fifth person to say hello. The end-user id is hashed before it becomes a key: the counter table
 * never learns a Telegram id.
 */
export interface ServiceIdentity {
  /** `svc:<hash of end user>`: the per-user daily counter. */
  userKey: string;
  /** Fixed per-service counter, so one token cannot use the whole global allowance. */
  serviceKey: string;
}

export function serviceIdentity(req: Request): ServiceIdentity | null {
  const expected = process.env.ASSISTANT_SERVICE_TOKEN?.trim();
  if (!expected || expected.length < 16) return null;
  const provided = req.headers.get("x-bstocks-service");
  const endUser = req.headers.get("x-end-user")?.trim();
  if (!provided || !endUser || !secretEquals(provided, expected)) return null;
  return { userKey: `svc:${createHash("sha256").update(endUser).digest("hex").slice(0, 16)}`, serviceKey: "svc:all" };
}

const memoryDaily = new Map<string, { day: string; count: number }>();
const memoryBurst = new Map<string, number[]>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function increment(key: string): Promise<number> {
  const day = today();
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.rpc("ai_usage_increment", { p_key: key, p_day: day });
      if (!error && typeof data === "number") return data;
      metrics.count("ai.quota.db", false, error?.message ?? "bad rpc result");
    } catch (err) {
      metrics.count("ai.quota.db", false, err instanceof Error ? err.message : String(err));
    }
  }
  const cur = memoryDaily.get(key);
  const next = cur && cur.day === day ? cur.count + 1 : 1;
  memoryDaily.set(key, { day, count: next });
  return next;
}

async function peek(key: string): Promise<number> {
  const day = today();
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data } = await sb.from("ai_usage").select("count").eq("key", key).eq("day", day).maybeSingle();
      if (data && typeof (data as { count?: number }).count === "number") return (data as { count: number }).count;
      return 0;
    } catch {
      /* fall through */
    }
  }
  const cur = memoryDaily.get(key);
  return cur && cur.day === day ? cur.count : 0;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: "burst" | "ip" | "wallet" | "global" | "service-user" | "service";
  remainingForWallet: number;
  remainingForIp: number;
}

/** Check limits without consuming. A service identity replaces the IP counters with its own two. */
export async function checkQuota(ip: string, wallet: string | undefined, limits: QuotaLimits, service?: ServiceIdentity | null): Promise<QuotaDecision> {
  if (service) {
    const [userCount, serviceCount, globalCount] = await Promise.all([peek(service.userKey), peek(service.serviceKey), peek("global")]);
    const remaining = Math.max(0, limits.perServiceUserPerDay - userCount);
    const decision = { remainingForWallet: remaining, remainingForIp: Math.max(0, limits.perServicePerDay - serviceCount) };
    if (userCount >= limits.perServiceUserPerDay) return { allowed: false, reason: "service-user", ...decision };
    if (serviceCount >= limits.perServicePerDay) return { allowed: false, reason: "service", ...decision };
    if (globalCount >= limits.globalPerDay) return { allowed: false, reason: "global", ...decision };
    return { allowed: true, ...decision };
  }
  const ipKey = `ip:${hashIp(ip)}`;
  const now = Date.now();
  const burst = (memoryBurst.get(ipKey) ?? []).filter((t) => now - t < 60_000);
  memoryBurst.set(ipKey, burst);
  const [ipCount, walletCount, globalCount] = await Promise.all([peek(ipKey), wallet ? peek(`wallet:${wallet.toLowerCase()}`) : Promise.resolve(0), peek("global")]);
  const remainingForIp = Math.max(0, limits.perIpPerDay - ipCount);
  const remainingForWallet = wallet ? Math.max(0, limits.perWalletPerDay - walletCount) : remainingForIp;
  if (burst.length >= limits.perIpPerMinute) return { allowed: false, reason: "burst", remainingForWallet, remainingForIp };
  if (ipCount >= limits.perIpPerDay) return { allowed: false, reason: "ip", remainingForWallet, remainingForIp };
  if (wallet && walletCount >= limits.perWalletPerDay) return { allowed: false, reason: "wallet", remainingForWallet, remainingForIp };
  if (globalCount >= limits.globalPerDay) return { allowed: false, reason: "global", remainingForWallet, remainingForIp };
  return { allowed: true, remainingForWallet, remainingForIp };
}

/** Consume one unit on every counter (call only after a successful model request is about to run). */
export async function consumeQuota(ip: string, wallet: string | undefined, service?: ServiceIdentity | null): Promise<void> {
  if (service) {
    await Promise.all([increment(service.userKey), increment(service.serviceKey), increment("global")]);
    return;
  }
  const ipKey = `ip:${hashIp(ip)}`;
  const burst = memoryBurst.get(ipKey) ?? [];
  burst.push(Date.now());
  memoryBurst.set(ipKey, burst);
  await Promise.all([increment(ipKey), wallet ? increment(`wallet:${wallet.toLowerCase()}`) : Promise.resolve(0), increment("global")]);
}

/* ---------------- Monthly spend guard ---------------- */

const SPEND_KEY = "spend-microusd";
const memorySpend = new Map<string, number>();

function monthKey(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

export function monthlyBudgetUsd(): number {
  const v = Number(process.env.AI_MONTHLY_BUDGET_USD);
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** Estimated USD spent on model calls this calendar month (persisted per month in `ai_usage`). */
export async function monthlySpendUsd(): Promise<number> {
  const month = monthKey();
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data } = await sb.from("ai_usage").select("count").eq("key", SPEND_KEY).eq("day", month).maybeSingle();
      const micro = data && typeof (data as { count?: number }).count === "number" ? (data as { count: number }).count : 0;
      return micro / 1_000_000;
    } catch {
      /* fall through */
    }
  }
  return (memorySpend.get(month) ?? 0) / 1_000_000;
}

/** Add one call's estimated cost. Read-modify-write is fine here: it guards a budget, it is not an invoice. */
export async function addSpend(usd: number): Promise<void> {
  const micro = Math.max(0, Math.round(usd * 1_000_000));
  if (micro === 0) return;
  const month = monthKey();
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data } = await sb.from("ai_usage").select("count").eq("key", SPEND_KEY).eq("day", month).maybeSingle();
      const current = data && typeof (data as { count?: number }).count === "number" ? (data as { count: number }).count : 0;
      const { error } = await sb.from("ai_usage").upsert({ key: SPEND_KEY, day: month, count: current + micro }, { onConflict: "key,day" });
      if (!error) return;
      metrics.count("ai.quota.db", false, error.message);
    } catch (err) {
      metrics.count("ai.quota.db", false, err instanceof Error ? err.message : String(err));
    }
  }
  memorySpend.set(month, (memorySpend.get(month) ?? 0) + micro);
}

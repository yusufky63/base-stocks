import { getSupabaseAdmin } from "@/db/supabase";
import { metrics } from "@/lib/http";

/**
 * The second tier under `cached()`: a store every server instance can read, so a value one
 * instance computed (prices, the asset registry, the statistics, a news feed) serves the others
 * instead of each instance asking the upstream again. Serverless instances share nothing in
 * memory; this is what keeps a thousand visitors from becoming a thousand RPC calls.
 *
 * Two backends behind one interface: Upstash Redis when `UPSTASH_REDIS_REST_URL` and
 * `UPSTASH_REDIS_REST_TOKEN` are set (fast, made for this), otherwise the `kv_cache` table in
 * Supabase (already there, a little slower). Neither is required: without both, `cached()` is
 * memory-only, as before.
 */
export interface SharedEntry {
  /** Encoded with `lib/codec`. */
  value: string;
  expiresAt: number;
  staleUntil: number;
}

export interface SharedStore {
  readonly name: string;
  get(key: string): Promise<SharedEntry | null>;
  set(key: string, entry: SharedEntry): Promise<void>;
  /** Drop entries nobody could still serve. Returns how many were removed, when the backend knows. */
  sweep(): Promise<number>;
}

class UpstashStore implements SharedStore {
  readonly name = "upstash";
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}
  private async command<T>(args: unknown[]): Promise<T> {
    const res = await fetch(this.url, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify(args), cache: "no-store" });
    const body = (await res.json()) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `upstash ${res.status}`);
    return body.result as T;
  }
  async get(key: string) {
    const raw = await this.command<string | null>(["GET", key]);
    if (!raw) return null;
    return JSON.parse(raw) as SharedEntry;
  }
  async set(key: string, entry: SharedEntry) {
    const ttlSec = Math.max(1, Math.ceil((entry.staleUntil - Date.now()) / 1000));
    await this.command(["SET", key, JSON.stringify(entry), "EX", ttlSec]);
  }
  async sweep() {
    return 0; // Redis expires keys on its own.
  }
}

class SupabaseStore implements SharedStore {
  readonly name = "supabase";
  private sb() {
    const c = getSupabaseAdmin();
    if (!c) throw new Error("Supabase not configured");
    return c;
  }
  async get(key: string) {
    const { data, error } = await this.sb().from("kv_cache").select("value, expires_at, stale_until").eq("key", key).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { value: unknown; expires_at: number | string; stale_until: number | string };
    return { value: JSON.stringify(row.value), expiresAt: Number(row.expires_at), staleUntil: Number(row.stale_until) };
  }
  async set(key: string, entry: SharedEntry) {
    const { error } = await this.sb().from("kv_cache").upsert({ key, value: JSON.parse(entry.value), expires_at: entry.expiresAt, stale_until: entry.staleUntil, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) throw error;
  }
  async sweep() {
    const { data, error } = await this.sb().from("kv_cache").delete().lt("stale_until", Date.now()).select("key");
    if (error) throw error;
    return (data ?? []).length;
  }
}

let store: SharedStore | null | undefined;

export function getSharedStore(): SharedStore | null {
  if (store !== undefined) return store;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) store = new UpstashStore(url.replace(/\/+$/, ""), token);
  else if (getSupabaseAdmin()) store = new SupabaseStore();
  else store = null;
  if (store) metrics.count("cache.shared.backend", true, store.name);
  return store;
}

/** Tests and tools: swap the backend (pass null to go memory-only). */
export function setSharedStore(next: SharedStore | null | undefined): void {
  store = next;
}

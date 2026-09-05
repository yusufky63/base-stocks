import { decode, encode } from "./codec";
import { getSharedStore } from "./shared-store";
import { metrics } from "./http";

/**
 * In-process TTL cache with stale-while-revalidate, and an optional shared tier.
 *
 * Memory first: a hit costs nothing and answers every request inside a window. On a miss,
 * a key marked `shared` asks the shared store before computing — another instance may already
 * have the value — and writes what it computes back for the others. Per-wallet keys and
 * anything cheap stay memory-only; the shared tier is for what is expensive upstream and the
 * same for everyone (prices, the asset registry, feeds, the statistics).
 */
interface Entry<T> {
  value: T;
  expiresAt: number;
  staleUntil: number;
  inflight?: Promise<T>;
}

const store = new Map<string, Entry<unknown>>();

/** Keys are bounded: expired entries are swept every two minutes and the map never exceeds MAX_ENTRIES. */
const MAX_ENTRIES = 5_000;
function sweep(): void {
  const now = Date.now();
  for (const [k, e] of store) if (e.staleUntil <= now && !e.inflight) store.delete(k);
  if (store.size > MAX_ENTRIES) {
    let excess = store.size - MAX_ENTRIES;
    for (const k of store.keys()) {
      if (excess-- <= 0) break;
      store.delete(k);
    }
  }
}
const sweepTimer = setInterval(sweep, 2 * 60_000);
sweepTimer.unref?.();

export interface CacheOptions {
  /** Fresh window in ms. */
  ttlMs: number;
  /** Additional window in ms during which a stale value may be served while refreshing. */
  staleMs?: number;
  /** Also read from and write to the shared store, so every server instance computes it once. */
  shared?: boolean;
}

function setAbsolute<T>(key: string, value: T, expiresAt: number, staleUntil: number): void {
  store.set(key, { value, expiresAt, staleUntil });
}

/** Write-through to the shared tier; a failure there costs nothing but the sharing. */
function publish<T>(key: string, value: T, expiresAt: number, staleUntil: number): void {
  const shared = getSharedStore();
  if (!shared) return;
  let encoded: string;
  try {
    encoded = encode(value);
  } catch (err) {
    metrics.count("cache.shared.encode", false, err instanceof Error ? err.message : String(err));
    return;
  }
  void shared.set(key, { value: encoded, expiresAt, staleUntil }).catch((err) => metrics.count("cache.shared.set", false, err instanceof Error ? err.message : String(err)));
}

async function readShared<T>(key: string): Promise<{ value: T; expiresAt: number; staleUntil: number } | null> {
  const shared = getSharedStore();
  if (!shared) return null;
  try {
    const e = await shared.get(key);
    if (!e || e.staleUntil <= Date.now()) return null;
    return { value: decode<T>(e.value), expiresAt: e.expiresAt, staleUntil: e.staleUntil };
  } catch (err) {
    metrics.count("cache.shared.get", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function refreshInBackground<T>(key: string, opts: CacheOptions, loader: () => Promise<T>): void {
  const entry = store.get(key) as Entry<T> | undefined;
  if (!entry || entry.inflight) return;
  entry.inflight = loader()
    .then((value) => {
      set(key, value, opts);
      return value;
    })
    .catch(() => entry.value)
    .finally(() => {
      const e = store.get(key) as Entry<T> | undefined;
      if (e) e.inflight = undefined;
    });
}

export async function cached<T>(key: string, opts: CacheOptions, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;

  if (entry && entry.expiresAt > now) return entry.value;

  if (entry && entry.staleUntil > now) {
    // Serve stale, refresh in background (deduplicated).
    refreshInBackground(key, opts, loader);
    return entry.value;
  }

  if (entry?.inflight) return entry.inflight;

  const p = (async () => {
    if (opts.shared) {
      const hit = await readShared<T>(key);
      if (hit) {
        setAbsolute(key, hit.value, hit.expiresAt, hit.staleUntil);
        metrics.count("cache.shared.hit");
        if (hit.expiresAt <= Date.now()) refreshInBackground(key, opts, loader);
        return hit.value;
      }
    }
    const value = await loader();
    set(key, value, opts);
    return value;
  })();
  store.set(key, { value: entry?.value as T, expiresAt: 0, staleUntil: 0, inflight: p });
  try {
    return await p;
  } catch (err) {
    const e = store.get(key) as Entry<T> | undefined;
    if (e && e.expiresAt === 0 && e.staleUntil === 0) store.delete(key);
    throw err;
  }
}

export function set<T>(key: string, value: T, opts: CacheOptions): void {
  const now = Date.now();
  const expiresAt = now + opts.ttlMs;
  const staleUntil = now + opts.ttlMs + (opts.staleMs ?? 0);
  setAbsolute(key, value, expiresAt, staleUntil);
  if (opts.shared) publish(key, value, expiresAt, staleUntil);
}

export function peek<T>(key: string): T | undefined {
  const e = store.get(key) as Entry<T> | undefined;
  return e && e.staleUntil > Date.now() ? e.value : undefined;
}

export function invalidate(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

export const TTL = {
  /** Canonical B20 metadata: long cache, event-triggered refresh. */
  assetMetadata: { ttlMs: 10 * 60_000, staleMs: 60 * 60_000, shared: true },
  /** Chainlink: short. */
  oracle: { ttlMs: 15_000, staleMs: 60_000, shared: true },
  /** Market snapshots: short, respects API plan limits. */
  market: { ttlMs: 30_000, staleMs: 5 * 60_000, shared: true },
  ohlcv: { ttlMs: 60_000, staleMs: 10 * 60_000, shared: true },
  basename: { ttlMs: 5 * 60_000, staleMs: 30 * 60_000 },
  earn: { ttlMs: 2 * 60_000, staleMs: 10 * 60_000, shared: true },
  logo: { ttlMs: 24 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000, shared: true },
} as const;

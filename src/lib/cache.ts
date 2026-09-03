/**
 * Small in-process TTL cache with stale-while-revalidate.
 * Good enough for a single Node process; swap for Redis/KV behind the same API when scaling.
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
}

export async function cached<T>(key: string, opts: CacheOptions, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const entry = store.get(key) as Entry<T> | undefined;

  if (entry && entry.expiresAt > now) return entry.value;

  if (entry && entry.staleUntil > now) {
    // Serve stale, refresh in background (deduplicated).
    if (!entry.inflight) {
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
    return entry.value;
  }

  if (entry?.inflight) return entry.inflight;

  const p = loader().then((value) => {
    set(key, value, opts);
    return value;
  });
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
  store.set(key, {
    value,
    expiresAt: now + opts.ttlMs,
    staleUntil: now + opts.ttlMs + (opts.staleMs ?? 0),
  });
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
  assetMetadata: { ttlMs: 10 * 60_000, staleMs: 60 * 60_000 },
  /** Chainlink: short. */
  oracle: { ttlMs: 15_000, staleMs: 60_000 },
  /** Market snapshots: short, respects API plan limits. */
  market: { ttlMs: 30_000, staleMs: 5 * 60_000 },
  ohlcv: { ttlMs: 60_000, staleMs: 10 * 60_000 },
  basename: { ttlMs: 5 * 60_000, staleMs: 30 * 60_000 },
  earn: { ttlMs: 2 * 60_000, staleMs: 10 * 60_000 },
  logo: { ttlMs: 24 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000 },
} as const;

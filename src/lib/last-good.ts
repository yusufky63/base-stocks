import { getSharedStore } from "./shared-store";
import { encode, decode } from "./codec";
import { metrics } from "./http";

/**
 * The last value a loader ever produced, kept for weeks, so a bad minute upstream is never
 * shown as a fact.
 *
 * `cached()` remembers a value only for its stale window; when a provider is down for longer,
 * or the first request after a cold start hits a rate limit, the loader's honest answer is
 * "I don't know" — and the pages were turning that into "not issued" and "no pool", which are
 * claims about the stock, not about the provider. A last-good value has no window to run out
 * of: it is replaced by the next good read and read back on the next bad one, in this process
 * first and from the shared store after a cold start. Each entry carries when it was read, so a
 * caller can still decide that a value is too old to show.
 */
interface Remembered<T> {
  value: T;
  /** Unix ms when the value was read from upstream. */
  at: number;
}

const memory = new Map<string, Remembered<unknown> & { encoded: string }>();
const KEEP_MS = 30 * 24 * 3600_000;
const PREFIX = "lastgood:";

export async function recallGood<T>(key: string): Promise<Remembered<T> | null> {
  const mem = memory.get(key);
  if (mem) return { value: mem.value as T, at: mem.at };
  const shared = getSharedStore();
  if (!shared) return null;
  try {
    const e = await shared.get(PREFIX + key);
    if (!e) return null;
    const r = decode<Remembered<T>>(e.value);
    memory.set(key, { ...r, encoded: e.value });
    return r;
  } catch (err) {
    metrics.count("lastgood.get", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Keep `value` as the last good reading of `key`. Writes through to the shared store only when it changed. */
export function rememberGood<T>(key: string, value: T, at = Date.now()): void {
  let encoded: string;
  try {
    encoded = encode({ value, at });
  } catch (err) {
    metrics.count("lastgood.encode", false, err instanceof Error ? err.message : String(err));
    return;
  }
  const prev = memory.get(key);
  memory.set(key, { value, at, encoded });
  // Same value as last time (timestamps aside): nothing to publish.
  if (prev && sameValue(prev.encoded, encoded)) return;
  const shared = getSharedStore();
  if (!shared) return;
  void shared.set(PREFIX + key, { value: encoded, expiresAt: at + KEEP_MS, staleUntil: at + KEEP_MS }).catch((err) => metrics.count("lastgood.set", false, err instanceof Error ? err.message : String(err)));
}

function sameValue(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/"at":\d+/, "");
  return strip(a) === strip(b);
}

/** Test seam. */
export function resetLastGoodMemory(): void {
  memory.clear();
}

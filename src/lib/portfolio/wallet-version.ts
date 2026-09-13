import type { Address } from "viem";
import { getSharedStore } from "@/lib/shared-store";
import { metrics } from "@/lib/http";

/**
 * A per-wallet version number every instance can see, so a cache keyed by wallet can be dropped
 * everywhere at once.
 *
 * `invalidate()` used to delete an in-process key, which on serverless means the instance that
 * recorded the trade forgot the snapshot and the other nine kept serving the old one for the
 * rest of its window. The version is part of the cache key instead: bumping it makes every
 * instance's entry unreachable the next time it is asked, with no coordination beyond one shared
 * read. The version is a timestamp, not a counter, so a bump never has to read before it writes.
 */
const PREFIX = "ver:wallet:";
/** Kept for a month; a wallet that has not been invalidated in that long can start from zero again. */
const KEEP_MS = 30 * 24 * 3600_000;

const local = new Map<string, number>();

export async function walletVersion(owner: Address): Promise<number> {
  const key = `${PREFIX}${owner.toLowerCase()}`;
  const shared = getSharedStore();
  if (!shared) return local.get(key) ?? 0;
  try {
    const e = await shared.get(key);
    const v = e ? Number(JSON.parse(e.value)) : 0;
    return Number.isFinite(v) ? v : 0;
  } catch (err) {
    metrics.count("cache.wallet-version", false, err instanceof Error ? err.message : String(err));
    return local.get(key) ?? 0;
  }
}

/** Make every per-wallet cache entry keyed on the version unreachable, on every instance. */
export async function bumpWalletVersion(owner: Address): Promise<number> {
  const key = `${PREFIX}${owner.toLowerCase()}`;
  const v = Date.now();
  local.set(key, v);
  const shared = getSharedStore();
  if (!shared) return v;
  await shared.set(key, { value: JSON.stringify(v), expiresAt: v + KEEP_MS, staleUntil: v + KEEP_MS }).catch((err) => metrics.count("cache.wallet-version", false, err instanceof Error ? err.message : String(err)));
  return v;
}

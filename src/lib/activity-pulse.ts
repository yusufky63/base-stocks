/**
 * "Is anyone here?" signal for background work. Every API request stamps the time; warm-ups and
 * scheduled probes run only while someone used the app recently, so an idle deployment makes no
 * RPC or provider calls at all.
 */
interface Global {
  __bstocksLastRequestAt?: number;
}
const g = globalThis as unknown as Global;

export function touchActivity(): void {
  g.__bstocksLastRequestAt = Date.now();
}

export function lastRequestAt(): number {
  return g.__bstocksLastRequestAt ?? 0;
}

/** True when a request arrived within `windowMs` (default 10 minutes). */
export function isActive(windowMs = 10 * 60_000): boolean {
  return Date.now() - lastRequestAt() < windowMs;
}

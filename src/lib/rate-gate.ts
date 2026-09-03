/**
 * Process-wide spacing between calls to a keyless upstream (GeckoTerminal allows ~30 req/min).
 * Callers await `gate(name, minIntervalMs)` before fetching; bursts (warm-up, status probes, a
 * page opening many stocks) are serialized instead of tripping 429s and the circuit breaker.
 */
const g = globalThis as unknown as { __bstocksRateGate?: Map<string, Promise<void>> };
const chains = (g.__bstocksRateGate ??= new Map<string, Promise<void>>());
const lastAt = new Map<string, number>();

export function gate(name: string, minIntervalMs: number): Promise<void> {
  const prev = chains.get(name) ?? Promise.resolve();
  const next = prev.then(async () => {
    const wait = (lastAt.get(name) ?? 0) + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt.set(name, Date.now());
  });
  chains.set(name, next.catch(() => undefined));
  return next;
}

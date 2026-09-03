import { AppError } from "@/lib/errors";

export interface FetchJsonOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Label for observability. */
  provider: string;
}

/** fetch with timeout that never throws raw provider text into the UI. */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions): Promise<{ status: number; data: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data: T;
    try {
      data = (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new AppError("PROVIDER_UNAVAILABLE", `${opts.provider}: invalid JSON`, 502);
    }
    recordLatency(opts.provider, Date.now() - started, res.ok);
    return { status: res.status, data };
  } catch (err) {
    recordLatency(opts.provider, Date.now() - started, false);
    if (err instanceof AppError) throw err;
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new AppError("PROVIDER_UNAVAILABLE", `${opts.provider}: ${isAbort ? "timeout" : "network error"}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal circuit breaker: after N consecutive failures, fail fast for `openMs`. */
const breakerRegistry = new Map<string, CircuitBreaker>();

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    public readonly name: string,
    private readonly threshold = 3,
    private readonly openMs = 20_000,
  ) {
    breakerRegistry.set(name, this);
  }

  /** Every breaker created in this process (for the status page). */
  static all(): Array<{ name: string; open: boolean; openUntil: number }> {
    return [...breakerRegistry.values()].map((b) => ({ name: b.name, open: b.isOpen, openUntil: b.openUntil }));
  }

  get isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen) {
      throw new AppError("PROVIDER_UNAVAILABLE", `${this.name}: circuit open`, 503);
    }
    try {
      const r = await fn();
      this.failures = 0;
      return r;
    } catch (err) {
      this.failures += 1;
      if (this.failures >= this.threshold) {
        this.openUntil = Date.now() + this.openMs;
        this.failures = 0;
        metrics.breakerOpened(this.name);
      }
      throw err;
    }
  }
}

/* ---------- Observability (in-memory; export to your APM of choice) ---------- */

interface ProviderStats {
  calls: number;
  errors: number;
  totalLatencyMs: number;
  lastError?: string;
  breakerOpens: number;
}

const stats = new Map<string, ProviderStats>();

function getStats(name: string): ProviderStats {
  let s = stats.get(name);
  if (!s) {
    s = { calls: 0, errors: 0, totalLatencyMs: 0, breakerOpens: 0 };
    stats.set(name, s);
  }
  return s;
}

function recordLatency(provider: string, ms: number, ok: boolean) {
  const s = getStats(provider);
  s.calls += 1;
  s.totalLatencyMs += ms;
  if (!ok) s.errors += 1;
}

export const metrics = {
  breakerOpened(name: string) {
    getStats(name).breakerOpens += 1;
  },
  count(name: string, ok = true, note?: string) {
    const s = getStats(name);
    s.calls += 1;
    if (!ok) {
      s.errors += 1;
      if (note) s.lastError = note.slice(0, 200);
    }
  },
  snapshot(): Record<string, ProviderStats & { avgLatencyMs: number }> {
    const out: Record<string, ProviderStats & { avgLatencyMs: number }> = {};
    for (const [k, v] of stats) out[k] = { ...v, avgLatencyMs: v.calls ? Math.round(v.totalLatencyMs / v.calls) : 0 };
    return out;
  },
};

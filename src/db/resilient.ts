import { metrics } from "@/lib/http";

/**
 * Wrap a repository so storage failures (missing tables, network blips) degrade to safe
 * fallbacks instead of failing the request. App records are never proof of execution, so
 * serving an empty list is always safer than a 500.
 */
export function resilient<T extends object>(name: string, repo: T, fallbacks: { [K in keyof T]?: unknown }): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).concat(Object.keys(repo))) {
    if (key === "constructor") continue;
    const fn = (repo as Record<string, unknown>)[key];
    if (typeof fn !== "function") continue;
    out[key] = async (...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>).apply(repo, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        metrics.count(`db.${name}.${key}`, false, message);
        if (/schema cache|does not exist|PGRST205/i.test(message)) schemaMissing.add(name);
        if (key in fallbacks) {
          const fb = fallbacks[key as keyof T];
          return typeof fb === "function" ? (fb as (...a: unknown[]) => unknown)(...args) : fb;
        }
        throw err;
      }
    };
  }
  return out as T;
}

/** Repos that hit a missing-table error at least once (surfaced by /api/health). */
export const schemaMissing = new Set<string>();

import { metrics } from "@/lib/http";
import { recordError } from "@/lib/error-sink";

/**
 * A storage failure on a write that must not be lost. It carries the cause's Postgres `code`, and
 * callers that read other errors as a verdict about the record itself (the verification sweep marks
 * a record failed when its receipt contradicts it) rethrow this one instead: a database blip is
 * not evidence against a trade.
 */
export class StorageError extends Error {
  readonly code?: string;
  constructor(
    readonly repo: string,
    readonly method: string,
    cause: unknown,
  ) {
    super(`storage: ${repo}.${method} failed: ${messageOf(cause)}`, { cause });
    this.name = "StorageError";
    const code = (cause as { code?: unknown } | null)?.code;
    if (typeof code === "string") this.code = code;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const isSchemaMissing = (message: string) => /schema cache|does not exist|PGRST205/i.test(message);

/** Postgres 23505: the row is already there, which for a write means it was stored before. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505" || /duplicate key value/i.test(messageOf(err));
}

/**
 * Wrap a repository so storage failures (missing tables, network blips) degrade to safe
 * fallbacks instead of failing the request. App records are never proof of execution, so
 * serving an empty list is always safer than a 500.
 *
 * Writes named in `durable` are the exception. They store something a person did (a trade, a gift,
 * a plan), and answering "saved" for a row that never landed loses it for good, with nothing in
 * the logs but an in-memory counter. Such a write falls back only when its table does not exist
 * (the feature is not set up on this deployment) or when the row is already there (a retried
 * request); any other failure is recorded in the error sink and raised as a `StorageError`.
 */
export function resilient<T extends object>(name: string, repo: T, fallbacks: { [K in keyof T]?: unknown }, opts: { durable?: ReadonlyArray<keyof T & string> } = {}): T {
  const durable = new Set<string>(opts.durable ?? []);
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).concat(Object.keys(repo))) {
    if (key === "constructor") continue;
    const fn = (repo as Record<string, unknown>)[key];
    if (typeof fn !== "function") continue;
    out[key] = async (...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>).apply(repo, args);
      } catch (err) {
        const message = messageOf(err);
        metrics.count(`db.${name}.${key}`, false, message);
        const missing = isSchemaMissing(message);
        if (missing) schemaMissing.add(name);
        if (durable.has(key) && !missing && !isUniqueViolation(err)) {
          void recordError({ source: "server", route: `db:${name}.${key}`, message, stack: err instanceof Error ? err.stack : undefined });
          throw new StorageError(name, key, err);
        }
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

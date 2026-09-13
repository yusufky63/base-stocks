import { getSupabaseAdmin } from "@/db/supabase";
import { metrics } from "@/lib/http";

/**
 * Where errors go, so somebody sees them.
 *
 * Until now an error was a `console.error` line on a serverless instance that was gone a minute
 * later. Every error now lands as one row per distinct error (a fingerprint over source, route
 * and the message with numbers and hashes stripped), counted, with the last stack kept. The admin
 * page and `/api/health` read them back; the monitor workflow raises an alert when the last hour
 * is loud. Recording never throws and never blocks a response.
 *
 * Only production writes rows. A local `.env` points at the same Supabase project, so every
 * half-finished edit during `next dev` — a component referenced before its import was written —
 * used to land in the production console and sit in the 24-hour list next to real incidents.
 * Development keeps the in-memory view, which is the one a developer is actually looking at; set
 * `ERROR_SINK_WRITES=always` when you deliberately want to exercise the stored path.
 */
export type ErrorSource = "server" | "route" | "client";

export interface ErrorReport {
  source: ErrorSource;
  route?: string;
  message: string;
  stack?: string;
  digest?: string;
  meta?: Record<string, unknown>;
}

export interface ErrorEvent extends ErrorReport {
  fingerprint: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

const MEMORY_MAX = 200;
const memory = new Map<string, ErrorEvent>();
/** The same error in a tight loop is written once per interval, not once per occurrence. */
const recentlyWritten = new Map<string, number>();
const WRITE_INTERVAL_MS = 10_000;

function normalize(message: string): string {
  return message
    .replace(/0x[0-9a-fA-F]{6,}/g, "0x…")
    .replace(/\d{3,}/g, "#")
    .slice(0, 300);
}

/** FNV-1a over the normalized identity: a stable bucket key, not a secret, and runtime-agnostic (no `node:crypto`). */
export function fingerprintOf(r: Pick<ErrorReport, "source" | "route" | "message">): string {
  const text = `${r.source}|${r.route ?? ""}|${normalize(r.message)}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export async function recordError(report: ErrorReport): Promise<void> {
  try {
    const message = report.message.slice(0, 500);
    const fingerprint = fingerprintOf({ ...report, message });
    const now = Date.now();
    const local = memory.get(fingerprint);
    if (local) {
      local.count += 1;
      local.lastAt = now;
      local.stack = report.stack?.slice(0, 4_000) ?? local.stack;
    } else {
      if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
      memory.set(fingerprint, { ...report, message, stack: report.stack?.slice(0, 4_000), fingerprint, count: 1, firstAt: now, lastAt: now });
    }
    metrics.count(`error.${report.source}`, false, message.slice(0, 120));
    if (process.env.NODE_ENV !== "production" && process.env.ERROR_SINK_WRITES !== "always") return;
    const sb = getSupabaseAdmin();
    if (!sb) return;
    const last = recentlyWritten.get(fingerprint) ?? 0;
    if (now - last < WRITE_INTERVAL_MS) return;
    recentlyWritten.set(fingerprint, now);
    if (recentlyWritten.size > 1_000) recentlyWritten.clear();
    const { error } = await sb.rpc("error_event_record", {
      p_fingerprint: fingerprint,
      p_source: report.source,
      p_route: report.route ?? null,
      p_message: message,
      p_digest: report.digest ?? null,
      p_stack: report.stack?.slice(0, 4_000) ?? null,
      p_meta: report.meta ?? {},
    });
    if (error) metrics.count("error.sink", false, error.message);
  } catch {
    // The sink must never be the thing that fails.
  }
}

/** The loudest distinct errors of the last `sinceMs`, newest first. */
export async function recentErrors(limit = 20, sinceMs = 24 * 3600_000): Promise<ErrorEvent[]> {
  const since = Date.now() - sinceMs;
  const sb = getSupabaseAdmin();
  if (sb) {
    try {
      const { data, error } = await sb.from("error_events").select("*").gte("last_at", new Date(since).toISOString()).order("last_at", { ascending: false }).limit(limit);
      if (!error && data) {
        return (data as Array<Record<string, unknown>>).map((r) => ({
          fingerprint: String(r.fingerprint),
          source: r.source as ErrorSource,
          route: (r.route as string | null) ?? undefined,
          message: String(r.message),
          digest: (r.digest as string | null) ?? undefined,
          stack: (r.stack as string | null) ?? undefined,
          meta: (r.meta as Record<string, unknown> | null) ?? undefined,
          count: Number(r.count),
          firstAt: new Date(String(r.first_at)).getTime(),
          lastAt: new Date(String(r.last_at)).getTime(),
        }));
      }
    } catch {
      /* fall through to memory */
    }
  }
  return [...memory.values()]
    .filter((e) => e.lastAt >= since)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit);
}

/**
 * How many distinct errors were seen in the last `sinceMs`.
 *
 * A row keeps a lifetime `count`, so summing those counted every occurrence a fingerprint had
 * ever had as if it had happened in the window: one old, noisy error touched once kept the
 * monitor alarm on indefinitely. Distinct errors is what the row shape can honestly answer, and
 * it is the more useful alarm anyway — twenty different things going wrong is a problem, one
 * thing going wrong twenty times is usually one problem.
 */
export async function errorCount(sinceMs = 3600_000): Promise<number> {
  return (await recentErrors(100, sinceMs)).length;
}

/**
 * The same count split by where the error came from. The server side is what the health alert
 * watches; browsers report through a public route and any visitor can invent twenty messages, so
 * client errors get their own, higher threshold instead of sharing the server one.
 */
export async function errorCountBySource(sinceMs = 3600_000): Promise<{ server: number; client: number }> {
  const rows = await recentErrors(200, sinceMs);
  let client = 0;
  for (const r of rows) if (r.source === "client") client += 1;
  return { server: rows.length - client, client };
}

/**
 * Retention: rows nobody will read again. A console keeps a fortnight of distinct errors, which
 * covers a postmortem; beyond that the table only grows. Returns how many rows went.
 */
export async function pruneErrors(olderThanMs = 14 * 24 * 3600_000): Promise<number> {
  return clearErrors({ olderThan: Date.now() - olderThanMs });
}

/**
 * Forget errors: one fingerprint, or every row last seen before `olderThan`.
 *
 * A fixed error keeps its row for a day, which is right for a postmortem and wrong for a console
 * you are watching during one — the list should show what is still happening. Clearing is an
 * admin action and it is not a cover-up: the row is a report of the past, and the error will
 * write a new one the moment it happens again.
 */
export async function clearErrors(opts: { fingerprint?: string; olderThan?: number } = {}): Promise<number> {
  const { fingerprint, olderThan } = opts;
  for (const [key, e] of [...memory]) {
    if (fingerprint ? key === fingerprint : olderThan === undefined || e.lastAt < olderThan) memory.delete(key);
  }
  const sb = getSupabaseAdmin();
  if (!sb) return 0;
  let q = sb.from("error_events").delete();
  q = fingerprint ? q.eq("fingerprint", fingerprint) : olderThan !== undefined ? q.lt("last_at", new Date(olderThan).toISOString()) : q.neq("fingerprint", "");
  const { data, error } = await q.select("fingerprint");
  if (error) {
    metrics.count("error.sink.clear", false, error.message);
    return 0;
  }
  return (data ?? []).length;
}

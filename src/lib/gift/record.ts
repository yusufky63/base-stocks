import { apiPatch, apiPost, ApiError } from "@/lib/client-api";

/**
 * Writing the transaction hash back to the app record is the step that makes a gift or a pool
 * findable: a draft without its hash is a 404 for the recipient and a lock on the sender's funds
 * that only the sweep can explain. The flows used to fire this request and forget it, so a closed
 * tab or one bad response lost the link. Now it is awaited and retried, and the caller shows
 * "recording" until it lands (or says that it did not).
 */
const BACKOFF_MS = [800, 2_000];

async function withRetry<T>(fn: () => Promise<T>, tries: number): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      // The server understood and refused (a mismatch, a missing record): asking again changes nothing.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) return null;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]));
    }
  }
  return null;
}

/** PATCH with retries; resolves to null when the record could not be written after every try. */
export function patchWithRetry<T = unknown>(path: string, body: unknown, tries = 3): Promise<T | null> {
  return withRetry(() => apiPatch<T>(path, body), tries);
}

/** POST with retries, for the claim report a claim page files after its transaction. */
export function postWithRetry<T = unknown>(path: string, body: unknown, tries = 3): Promise<T | null> {
  return withRetry(() => apiPost<T>(path, body), tries);
}

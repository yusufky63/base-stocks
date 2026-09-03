import { AppError } from "@/lib/errors";

export interface RaceOptions {
  /** Delay before the fallback is started while the primary is still pending. */
  hedgeDelayMs: number;
}

/**
 * Race a primary task against a hedged fallback chain.
 * - Primary succeeds first → its result (fallback, if started, is ignored).
 * - Primary fails at any time → fallback starts immediately (or its pending result is used).
 * - Primary is slow → fallback starts after `hedgeDelayMs`; first success wins.
 * - Everything fails → the most specific error (a typed non-outage error over a generic outage).
 */
export function raceWithFallback<T>(tasks: Array<() => Promise<T>>, opts: RaceOptions): Promise<T> {
  if (tasks.length === 0) return Promise.reject(new AppError("PROVIDER_UNAVAILABLE", "Trading is temporarily unavailable.", 503));
  const [primary, ...rest] = tasks;
  const primaryP = primary!();
  if (rest.length === 0) return primaryP;

  let fallbackP: Promise<T> | null = null;
  const startFallback = () => (fallbackP ??= raceWithFallback(rest, opts));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (fn: (v: never) => void, v: unknown) => {
      if (settled) return;
      settled = true;
      (fn as (x: unknown) => void)(v);
    };

    const timer = setTimeout(() => {
      startFallback().then(
        (v) => done(resolve, v),
        () => {
          /* hedge failed: wait for the primary to settle */
        },
      );
    }, opts.hedgeDelayMs);

    primaryP.then(
      (v) => {
        clearTimeout(timer);
        done(resolve, v);
      },
      (primaryErr: unknown) => {
        clearTimeout(timer);
        startFallback().then(
          (v) => done(resolve, v),
          (fallbackErr: unknown) => done(reject, pickError(primaryErr, fallbackErr)),
        );
      },
    );
  });
}

function pickError(primaryErr: unknown, fallbackErr: unknown): Error {
  const candidates = [primaryErr, fallbackErr];
  const detail = candidates.map((e) => (e instanceof Error ? e.message : String(e))).join(" | ");
  // Every provider found no route: a liquidity problem, explained in plain language (provider text kept in details).
  if (candidates.some((e) => e instanceof AppError && e.code === "ROUTE_UNAVAILABLE")) {
    return new AppError("ROUTE_UNAVAILABLE", "No route has enough onchain liquidity for this amount. Try a smaller amount or check back later.", 409, { providers: detail });
  }
  const specific = candidates.find((e) => e instanceof AppError && e.code !== "PROVIDER_UNAVAILABLE");
  if (specific instanceof AppError) return specific;
  return new AppError("PROVIDER_UNAVAILABLE", "Trading is temporarily unavailable.", 503, { providers: detail });
}

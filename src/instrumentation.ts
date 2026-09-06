/**
 * Server warm-up (Node runtime only). Keeps the shared market/asset cache hot so the first
 * visitor never waits on upstream providers and no visitor triggers a per-user fetch.
 * Harmless on serverless (the interval simply dies with the instance).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MARKET_WARMUP === "false") return;
  const { getAssets } = await import("@/services/b20-asset-service");
  const { getPriceViews } = await import("@/services/price-service");
  const { probeZeroXTokenizedStocks } = await import("@/providers/trading/zero-x/adapter");
  const { loadDiscoveredRegistry, syncDiscoveredAssets } = await import("@/services/b20-asset-service");
  const { isActive } = await import("@/lib/activity-pulse");
  const { getStatusReport } = await import("@/services/status-service");

  const refresh = async () => {
    // Nobody asked for anything in the last 10 minutes: let the caches go cold instead of polling the chain.
    if (!isActive()) return;
    try {
      const assets = await getAssets();
      await getPriceViews(assets);
    } catch (err) {
      console.warn("[warmup] market refresh failed:", err instanceof Error ? err.message : err);
    }
  };
  // Asset discovery: stored stocks first (fast), then a deep scan at boot and a light scan every 30 minutes.
  const discover = async (lookbackBlocks: bigint) => {
    const s = await syncDiscoveredAssets({ lookbackBlocks });
    console.info(`[warmup] asset discovery: ${s.candidates} candidate(s), ${s.autoVerified} auto-verified, ${s.active} active beyond the curated list${s.lastError ? ` · error: ${s.lastError}` : ""}`);
  };
  // Serverless (Vercel): instances are short-lived, so timers and the deep boot scan would repeat on
  // every cold start. Load the stored registry only; the cron route does discovery and probes.
  const serverless = !!process.env.VERCEL;
  void loadDiscoveredRegistry()
    .then(() => refresh())
    .then(() => (serverless ? undefined : discover(450_000n)))
    .catch((err) => console.warn("[warmup] discovery failed:", err instanceof Error ? err.message : err));
  if (serverless) return;
  const discoveryTimer = setInterval(() => void discover(60_000n), 30 * 60_000);
  discoveryTimer.unref?.();
  // Learn once whether 0x serves tokenized stocks for this key (opt-in required); re-checked hourly.
  const probe = async () => {
    const s = await probeZeroXTokenizedStocks();
    if (s.configured) console.info(`[warmup] 0x tokenized stocks: ${s.refusesTokenizedStocks ? "refused (opt-in pending) — fallback providers serve quotes" : "enabled"}`);
  };
  void probe();
  const probeTimer = setInterval(probe, 60 * 60_000);
  probeTimer.unref?.();
  const timer = setInterval(refresh, 30_000);
  timer.unref?.();
  // Status probes every 5 minutes while the app is in use, so the Status page has history and no visitor triggers a full probe run.
  const statusTimer = setInterval(() => {
    if (isActive()) void getStatusReport().catch(() => undefined);
  }, 5 * 60_000);
  statusTimer.unref?.();
}

/**
 * Framework notices that arrive here as errors but describe no failure. "Page changed from static
 * to dynamic" is the loudest: the home page is prerendered and then reads live prices with a
 * no-store fetch, which is the intended trade — a page that quotes prices must not be served from
 * a cache. Recording it once a request buried the real errors and kept the monitor alarm on.
 */
const NON_ERRORS = [/Page changed from static to dynamic at runtime/i];

/**
 * Server-side errors Next catches while rendering or handling a request (route handlers report
 * their own through `route()`). Recorded like every other error, so they are seen.
 */
export async function onRequestError(err: unknown, request: { path: string; method: string }, context: { routerKind: string; routeType: string; routePath?: string }): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (NON_ERRORS.some((re) => re.test(message))) return;
  const { recordError } = await import("@/lib/error-sink");
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest?: unknown }).digest) : undefined;
  await recordError({ source: "server", route: request.path, message, digest, stack: err instanceof Error ? err.stack : undefined, meta: { method: request.method, routerKind: context.routerKind, routeType: context.routeType, routePath: context.routePath } });
}

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

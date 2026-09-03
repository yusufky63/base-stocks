import type { Address } from "viem";
import { cached } from "@/lib/cache";
import { CircuitBreaker, metrics } from "@/lib/http";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { readFeeds } from "@/providers/market-data/chainlink/reader";
import { getDexScreenerMarkets } from "@/providers/market-data/dexscreener/adapter";
import { getGeckoTerminalPrices } from "@/providers/market-data/geckoterminal/adapter";
import { kyberProvider } from "@/providers/trading/kyber/adapter";
import { OkxTradeProvider, okxProvider } from "@/providers/trading/okx/adapter";
import { okxStatus } from "@/providers/okx/client";
import { veloraProvider } from "@/providers/trading/velora/adapter";
import { UniswapTradeProvider, uniswapProvider } from "@/providers/trading/uniswap/adapter";
import { zeroXStatus } from "@/providers/trading/zero-x/adapter";
import { getDexPools } from "@/providers/earn/geckoterminal-pools";
import { discoverUsdcEarn } from "./earn-opportunity-service";
import { discoveryStatus } from "./b20-asset-service";
import { resolveBasename } from "./basename-service";
import { getSupabaseAdmin } from "@/db/supabase";
import { getRepos } from "@/db/repositories";
import { NEWS_SOURCES } from "@/content/news-sources";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";
import { BASE_CHAIN_ID, USDC_ADDRESS } from "@/config/chain";
import { quotaLimitsFromEnv, monthlySpendUsd, monthlyBudgetUsd } from "@/lib/ai-quota";
import { aiConfigFromEnv } from "@/lib/ai-provider";
import { isAttributionEnabled } from "@/lib/attribution";
import type { TradeIntent } from "@/domain/trade";

/**
 * Live status of every upstream the app depends on. Each check is an active, bounded probe
 * (6 s) run in parallel and cached for 60 s (background run every 5 min while the app is in use), so the page never hammers a provider. Passive
 * signals (in-process metrics, circuit breakers) are attached for context. No secrets.
 */
export type ServiceStatus = "ok" | "degraded" | "down" | "off";

export interface ServiceCheck {
  id: string;
  group: "Chain" | "Prices & charts" | "Trading" | "Earn" | "News" | "Identity" | "Storage & AI";
  name: string;
  /** Smoothed: an outage needs two consecutive failed probes; a single failure shows as degraded. */
  status: ServiceStatus;
  /** Latest raw probe result before smoothing. */
  raw?: ServiceStatus;
  /** Oldest → newest, last 12 raw results in this process. */
  history?: ServiceStatus[];
  latencyMs: number | null;
  detail: string;
  url?: string;
}

const HISTORY_MAX = 12;
const HISTORY = new Map<string, ServiceStatus[]>();

/** Record the raw result and derive the smoothed status. */
function smooth(check: ServiceCheck): ServiceCheck {
  const prev = HISTORY.get(check.id) ?? [];
  const history = [...prev, check.status].slice(-HISTORY_MAX);
  HISTORY.set(check.id, history);
  const last = prev[prev.length - 1];
  const status: ServiceStatus = check.status === "down" && last !== "down" ? "degraded" : check.status;
  return { ...check, raw: check.status, status, history };
}

export interface StatusReport {
  overall: ServiceStatus;
  checks: ServiceCheck[];
  metrics: Record<string, { calls: number; errors: number; avgLatencyMs: number; breakerOpens: number; lastError?: string }>;
  breakers: Array<{ name: string; open: boolean; openUntil: number }>;
  generatedAt: number;
  uptimeSeconds: number;
}

const SAMPLE = CURATED_B20_ASSETS.find((a) => a.underlying === "NVDA") ?? CURATED_B20_ASSETS[0]!;
const TIMEOUT_MS = 6_000;

async function probe(id: string, group: ServiceCheck["group"], name: string, fn: () => Promise<{ status?: ServiceStatus; detail: string }>, url?: string): Promise<ServiceCheck> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
      }),
    ]);
    return { id, group, name, status: r.status ?? "ok", latencyMs: Date.now() - started, detail: r.detail, url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A 429 from a keyless upstream is back-pressure, not an outage: cached data keeps serving.
    const status: ServiceStatus = /rate limited|429/i.test(message) ? "degraded" : "down";
    return { id, group, name, status, latencyMs: Date.now() - started, detail: message.slice(0, 160), url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sampleIntent(): TradeIntent {
  return { chainId: BASE_CHAIN_ID, side: "buy", assetAddress: SAMPLE.address, sellToken: USDC_ADDRESS, buyToken: SAMPLE.address, sellAmount: 10_000_000n, sellTokenDecimals: 6, buyTokenDecimals: 8, slippageBps: 100 };
}

async function runChecks(): Promise<ServiceCheck[]> {
  const client = getServerPublicClient();
  const nvda = SAMPLE.address as Address;

  const checks = await Promise.all([
    probe("rpc", "Chain", "Base RPC", async () => {
      const block = await client.getBlockNumber();
      return { detail: `block ${block.toString()}` };
    }),
    probe("chainlink", "Chain", "Chainlink stock feeds", async () => {
      const m = await readFeeds([SAMPLE.chainlinkFeed]);
      const r = m.get(SAMPLE.chainlinkFeed.toLowerCase());
      if (!r) throw new Error("no reading");
      const ageMin = Math.round((Date.now() / 1000 - Number(r.updatedAt)) / 60);
      return { status: ageMin > 26 * 60 ? "degraded" : "ok", detail: `${SAMPLE.underlying} $${(Number(r.answer) / 10 ** r.decimals).toFixed(2)} · updated ${ageMin} min ago` };
    }, "https://docs.base.org/specifications/b20/tokenized-stocks-on-base"),
    probe("dexscreener", "Prices & charts", "DexScreener (market price)", async () => {
      const m = await getDexScreenerMarkets([nvda]);
      const r = m.get(nvda.toLowerCase());
      return r?.priceUsd ? { detail: `${SAMPLE.underlying} $${r.priceUsd.toFixed(2)} · liquidity $${Math.round(r.liquidityUsd ?? 0).toLocaleString("en-US")}` } : { status: "degraded", detail: "no pair data" };
    }, "https://dexscreener.com/base"),
    probe("geckoterminal", "Prices & charts", "GeckoTerminal (OHLCV, pools)", async () => {
      const m = await getGeckoTerminalPrices([nvda]);
      const r = m.get(nvda.toLowerCase());
      return r?.priceUsd ? { detail: `${SAMPLE.underlying} $${r.priceUsd.toFixed(2)} · 24h vol $${Math.round(r.volume24hUsd ?? 0).toLocaleString("en-US")}` } : { status: "degraded", detail: "no token data" };
    }, "https://www.geckoterminal.com/base"),
    probe("zeroX", "Trading", "0x Swap API", async () => {
      const s = zeroXStatus();
      if (!s.configured) return { status: "off", detail: "no API key configured" };
      if (s.refusesTokenizedStocks) return { status: "degraded", detail: `refuses tokenized stocks (opt-in pending) · re-check ${s.retryAt ? new Date(s.retryAt).toISOString().slice(11, 16) + " UTC" : "soon"}` };
      return { detail: "enabled for tokenized stocks" };
    }, "https://0x.org/docs"),
    probe("kyber", "Trading", "KyberSwap aggregator", async () => {
      const q = await kyberProvider.getIndicativeQuote(sampleIntent());
      return { detail: `10 USDC → ${(Number(q.buyAmount) / 1e8).toFixed(4)} ${SAMPLE.underlying} · ${q.provider}` };
    }, "https://kyberswap.com"),
    probe("okx", "Trading", "OKX DEX aggregator", async () => {
      if (!OkxTradeProvider.isConfigured()) return { status: "off", detail: "OKX_API_KEY / SECRET / PASSPHRASE not set" };
      try {
        const q = await okxProvider.getIndicativeQuote(sampleIntent());
        return { detail: `10 USDC → ${(Number(q.buyAmount) / 1e8).toFixed(4)} ${SAMPLE.underlying}` };
      } catch (err) {
        const st = okxStatus();
        if (st.state === "no-access") return { status: "degraded", detail: `key not entitled to the aggregator (OKX ${st.code ?? "401"}): enable the DEX API product for this project in the OKX developer portal` };
        throw err;
      }
    }, "https://web3.okx.com/build/dev-docs/dex-api"),
    probe("uniswap-api", "Trading", "Uniswap Trading API", async () => {
      if (!UniswapTradeProvider.isConfigured()) return { status: "off", detail: "UNISWAP_API_KEY not set" };
      const q = await uniswapProvider.getIndicativeQuote(sampleIntent());
      return { detail: `10 USDC → ${(Number(q.buyAmount) / 1e8).toFixed(4)} ${SAMPLE.underlying} · ${q.route.map((r) => r.source).join(", ")}` };
    }, "https://developers.uniswap.org/docs/trading/overview"),
    probe("velora", "Trading", "Velora (ParaSwap) aggregator", async () => {
      const q = await veloraProvider.getIndicativeQuote(sampleIntent());
      return { detail: `10 USDC → ${(Number(q.buyAmount) / 1e8).toFixed(4)} ${SAMPLE.underlying}` };
    }, "https://velora.xyz"),
    probe("earn-usdc", "Earn", "Morpho · Aave · Compound (USDC venues)", async () => {
      const r = await discoverUsdcEarn();
      const by = (p: string) => r.opportunities.filter((o) => o.provider === p).length;
      const unavailable = r.unavailableProviders.filter((p) => p !== "aerodrome" && p !== "uniswap");
      const detail = `morpho ${by("morpho")} · aave ${by("aave")} · compound ${by("compound")}${unavailable.length ? ` · unavailable: ${unavailable.join(", ")}` : ""}`;
      return { status: unavailable.length ? "degraded" : r.opportunities.length ? "ok" : "down", detail };
    }, "https://docs.morpho.org"),
    probe("dex-pools", "Earn", "DEX pool discovery (Aerodrome, Uniswap)", async () => {
      const pools = await getDexPools(nvda);
      const top = pools[0];
      return pools.length ? { detail: `${pools.length} pools for ${SAMPLE.underlying} · deepest ${top!.dexLabel} $${Math.round(top!.reserveUsd).toLocaleString("en-US")}` } : { status: "degraded", detail: "no pools returned" };
    }),
    probe("discovery", "Chain", "New-stock discovery (B20Created + Chainlink directory)", async () => {
      const d = discoveryStatus();
      if (d.lastError) return { status: "degraded", detail: `last scan failed: ${d.lastError.slice(0, 100)}` };
      if (!d.lastSyncAt) return { status: "degraded", detail: "no scan yet in this process" };
      return { detail: `scanned ${d.lastScanBlocks.toLocaleString("en-US")} blocks ${Math.round((Date.now() - d.lastSyncAt) / 60_000)} min ago · ${d.candidates} candidate(s) · ${d.active} discovered stock(s) live${d.discovered.length ? ` (${d.discovered.join(", ")})` : ""}` };
    }, "https://docs.base.org/specifications/b20/tokenized-stocks-on-base"),
    probe("basenames", "Identity", "Basenames resolver", async () => {
      const a = await resolveBasename("base.base.eth");
      return a ? { detail: `base.base.eth → ${a.slice(0, 8)}…` } : { status: "degraded", detail: "name did not resolve" };
    }, "https://www.base.org/names"),
    probe("supabase", "Storage & AI", "Supabase (Postgres)", async () => {
      const sb = getSupabaseAdmin();
      if (!sb) return { status: "off", detail: `memory backend (${getRepos().backend})` };
      const { error, count } = await sb.from("trade_records").select("*", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      return { detail: `tables reachable · ${count ?? 0} trade records` };
    }),
    probe("ai", "Storage & AI", "AI basket helper", async () => {
      const cfg = aiConfigFromEnv();
      if (!cfg) return { status: "off", detail: "no AI key set (ANTHROPIC_API_KEY or AI_PROVIDER=openai + AI_API_KEY) · drafting hidden" };
      const l = quotaLimitsFromEnv();
      const [spent, budget] = [await monthlySpendUsd(), monthlyBudgetUsd()];
      const over = budget > 0 && spent >= budget;
      return { status: over ? "degraded" : "ok", detail: `${cfg.provider} · ${cfg.model} · this month $${spent.toFixed(2)}${budget > 0 ? ` / $${budget} budget` : ""} · ${l.perWalletPerDay}/wallet · ${l.globalPerDay}/day${over ? " · budget reached, helper paused" : ""}` };
    }),
  ]);

  // News: passive, from the per-source breakers and metrics (feeds are fetched on demand, cached 15 min).
  const snap = metrics.snapshot();
  const breakers = new Map(CircuitBreaker.all().map((b) => [b.name, b]));
  const newsChecks: ServiceCheck[] = NEWS_SOURCES.map((s) => {
    const m = snap[`news.${s.id}`];
    const b = breakers.get(`news.${s.id}`);
    const errorRate = m && m.calls > 0 ? m.errors / m.calls : 0;
    const status: ServiceStatus = b?.open ? "down" : errorRate > 0.5 ? "degraded" : "ok";
    return { id: `news-${s.id}`, group: "News", name: s.label, status, latencyMs: m?.avgLatencyMs ?? null, detail: m ? `${m.calls} fetches · ${m.errors} errors${m.lastError ? ` · ${m.lastError.slice(0, 60)}` : ""}` : "not fetched yet in this process", url: s.homepage };
  });

  const app: ServiceCheck[] = [
    { id: "builder-code", group: "Identity", name: "Base Builder Code attribution", status: isAttributionEnabled() ? "ok" : "off", latencyMs: null, detail: isAttributionEnabled() ? "ERC-8021 suffix appended to every call" : "NEXT_PUBLIC_BASE_BUILDER_CODE not set", url: "https://docs.base.org/specifications/builder-codes/overview" },
  ];

  return [...checks, ...newsChecks, ...app];
}

export async function getStatusReport(): Promise<StatusReport> {
  return cached("status:report", { ttlMs: 60_000, staleMs: 5 * 60_000 }, async () => {
    const checks = (await runChecks()).map(smooth);
    const live = checks.filter((c) => c.status !== "off");
    const overall: ServiceStatus = live.some((c) => c.status === "down" && c.group !== "News") ? "down" : live.some((c) => c.status !== "ok") ? "degraded" : "ok";
    return { overall, checks, metrics: metrics.snapshot(), breakers: CircuitBreaker.all(), generatedAt: Date.now(), uptimeSeconds: Math.round(process.uptime()) };
  });
}

import { z } from "zod";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";

/**
 * US share prices from Yahoo Finance's chart endpoint, for the Coinbase stocks that have no
 * Chainlink feed.
 *
 * Why this source: Coinbase publishes a Chainlink feed for ten stocks; the other listed ones have
 * no onchain price and no `nav_price` in Coinbase's API, and Base's own guidance for them is the
 * underlying equity price times the token's multiplier. Pyth covers most of them but sells US
 * equities only in a paid plan; this endpoint answers without a key. It is unofficial and can
 * change or refuse a server, so everything built on it treats a missing answer as "no reference"
 * and the value is never published through the public API or used by a contract.
 */
const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const breaker = new CircuitBreaker("yahoo", 3, 60_000);

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string(),
            currency: z.string().nullable().optional(),
            regularMarketPrice: z.number().nullable().optional(),
            regularMarketTime: z.number().nullable().optional(),
          }),
          timestamp: z.array(z.number()).nullable().optional(),
          indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()).nullable().optional() })).optional() }).optional(),
        }),
      )
      .nullable()
      .optional(),
  }),
});

export interface EquityQuote {
  symbol: string;
  /** Last regular-session price of ONE share, in USD. */
  priceUsd: number;
  /** Unix ms of that price. */
  updatedAt: number;
  /** Hourly closes over the last seven days, oldest first (unix seconds). */
  points: Array<{ time: number; price: number }>;
}

/** Yahoo writes share classes with a dash: BRK.B is BRK-B. */
export function yahooSymbol(underlying: string): string {
  return underlying.trim().toUpperCase().replace(/\./g, "-");
}

export function parseChart(raw: unknown): EquityQuote | null {
  const parsed = chartSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data.chart.result?.[0];
  if (!r) return null;
  const { meta } = r;
  // A quote in another currency would be read as dollars; refuse it rather than convert it.
  if (meta.currency && meta.currency.toUpperCase() !== "USD") return null;
  const price = meta.regularMarketPrice;
  const time = meta.regularMarketTime;
  if (typeof price !== "number" || !(price > 0) || typeof time !== "number" || !(time > 0)) return null;
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const points: EquityQuote["points"] = [];
  (r.timestamp ?? []).forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number" && c > 0) points.push({ time: t, price: c });
  });
  return { symbol: meta.symbol, priceUsd: price, updatedAt: time * 1000, points };
}

/** One stock's last price and week of hourly closes; null when Yahoo has nothing usable for it. */
export async function getYahooQuote(underlying: string): Promise<EquityQuote | null> {
  const symbol = yahooSymbol(underlying);
  try {
    const { status, data } = await breaker.run(() =>
      // Without a browser-like agent the endpoint answers 429 to most servers.
      fetchJson<unknown>(`${BASE_URL}/${encodeURIComponent(symbol)}?range=7d&interval=1h`, { timeoutMs: 8_000, provider: "yahoo", headers: { "user-agent": "Mozilla/5.0 (compatible; BStocks/1.0; +https://basestocks.finance)" } }),
    );
    if (status >= 400) {
      metrics.count("yahoo.chart", false, `http ${status}`);
      return null;
    }
    const quote = parseChart(data);
    metrics.count("yahoo.chart", quote !== null, quote ? undefined : `no usable quote for ${symbol}`);
    return quote;
  } catch (err) {
    metrics.count("yahoo.chart", false, err instanceof Error ? err.message : String(err));
    return null;
  }
}

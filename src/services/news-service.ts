import { cached } from "@/lib/cache";
import { CircuitBreaker, metrics } from "@/lib/http";
import { NEWS_SOURCES, type NewsVia } from "@/content/news-sources";

/**
 * Short stock headlines from several publishers, keyless RSS only:
 *   per ticker  → Google News (aggregator), Yahoo Finance, Nasdaq, Seeking Alpha
 *   market-wide → CNBC, MarketWatch, WSJ Markets, Investing.com
 * Only titles, sources and links are stored (no article text). Shared server cache: one fetch
 * per feed per 15 minutes serves every visitor; stale results are served while refreshing.
 */
export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  /** Unix ms. */
  publishedAt: number;
  /** Ticker the headline was fetched for; "MARKETS" for market-wide feeds. */
  ticker: string;
  via: NewsVia;
}

const breakers = Object.fromEntries(NEWS_SOURCES.map((s) => [s.id, new CircuitBreaker(`news.${s.id}`, 3, 60_000)])) as Record<NewsVia, CircuitBreaker>;

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : null;
}

/** Minimal RSS 2.0 item parser (titles, links, dates, publisher). */
export function parseRss(xml: string): Array<{ title: string; link: string; pubDate: string | null; source: string | null }> {
  const items: Array<{ title: string; link: string; pubDate: string | null; source: string | null }> = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && items.length < 40) {
    const block = m[1]!;
    const title = tag(block, "title");
    const link = tag(block, "link") ?? block.match(/<link>([^<]+)/)?.[1]?.trim() ?? null;
    if (!title || !link || !/^https?:\/\//i.test(link)) continue;
    items.push({ title, link, pubDate: tag(block, "pubDate"), source: tag(block, "source") });
  }
  return items;
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; BStocks/1.0)", accept: "application/rss+xml, application/xml, text/xml" }, cache: "no-store" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}

function toItems(via: NewsVia, ticker: string, defaultSource: string, parsed: ReturnType<typeof parseRss>): NewsItem[] {
  return parsed.map((it) => ({ id: `${via}:${normalizeTitle(it.title)}`, title: it.title, url: it.link, source: it.source ?? defaultSource, publishedAt: it.pubDate ? Date.parse(it.pubDate) || 0 : 0, ticker, via }));
}

async function feed(via: NewsVia, url: string, ticker: string, defaultSource: string): Promise<NewsItem[]> {
  const xml = await breakers[via].run(() => fetchText(url, 7_000));
  return toItems(via, ticker, defaultSource, parseRss(xml));
}

async function google(ticker: string, name: string): Promise<NewsItem[]> {
  const q = encodeURIComponent(`${name} ${ticker} stock`);
  const xml = await breakers.google.run(() => fetchText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, 7_000));
  return parseRss(xml).map((it) => {
    const src = it.source ?? it.title.split(" - ").pop() ?? "Google News";
    const title = it.source ? it.title.replace(new RegExp(`\\s-\\s${it.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "") : it.title.replace(/\s-\s[^-]+$/, "");
    return { id: `google:${normalizeTitle(title)}`, title, url: it.link, source: src, publishedAt: it.pubDate ? Date.parse(it.pubDate) || 0 : 0, ticker, via: "google" as const };
  });
}

const TICKER_FEEDS: Array<{ via: NewsVia; url: (ticker: string) => string; source: string }> = [
  { via: "yahoo", url: (t) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`, source: "Yahoo Finance" },
  { via: "nasdaq", url: (t) => `https://www.nasdaq.com/feed/rssoutbound?symbol=${encodeURIComponent(t)}`, source: "Nasdaq" },
  { via: "seekingalpha", url: (t) => `https://seekingalpha.com/api/sa/combined/${encodeURIComponent(t)}.xml`, source: "Seeking Alpha" },
];

const MARKET_FEEDS: Array<{ via: NewsVia; url: string; source: string }> = [
  { via: "cnbc", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", source: "CNBC" },
  { via: "marketwatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", source: "MarketWatch" },
  { via: "wsj", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", source: "WSJ" },
  { via: "investing", url: "https://www.investing.com/rss/news_25.rss", source: "Investing.com" },
];

/** Extra name variants so relevance matching survives "Alphabet" vs "Google", "Strategy" vs "MicroStrategy". */
const ALIASES: Record<string, string[]> = {
  GOOGL: ["google", "alphabet"],
  META: ["meta", "facebook", "instagram"],
  MSTR: ["strategy", "microstrategy", "saylor"],
  COIN: ["coinbase"],
  CRCL: ["circle", "usdc"],
  SNDK: ["sandisk"],
  SPCX: ["spacex", "starlink"],
  NVDA: ["nvidia"],
  AMZN: ["amazon", "aws"],
  MSFT: ["microsoft", "azure", "openai"],
  AAPL: ["apple", "iphone"],
  INTC: ["intel"],
  TSLA: ["tesla", "musk"],
};

/** Keep only headlines that actually mention the company or ticker (ticker feeds mix in unrelated wires). */
function isRelevant(it: NewsItem, ticker: string, name: string): boolean {
  if (it.via === "google" || it.via === "seekingalpha") return true; // query / symbol scoped already
  const t = it.title.toLowerCase();
  const words = [ticker.toLowerCase(), ...(ALIASES[ticker.toUpperCase()] ?? []), ...name.toLowerCase().split(/\s+/).filter((w) => w.length > 3)];
  return words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t));
}

function dedupe(items: NewsItem[], limit: number): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const key = normalizeTitle(it.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/** Headlines for one ticker, merged from all sources, relevance-filtered, de-duplicated, newest first. */
export async function getNews(ticker: string, name: string, limit = 8): Promise<NewsItem[]> {
  const all = await cached(`news:${ticker}`, { ttlMs: 15 * 60_000, staleMs: 6 * 60 * 60_000 }, async () => {
    const tasks: Array<Promise<NewsItem[]>> = [google(ticker, name), ...TICKER_FEEDS.map((f) => feed(f.via, f.url(ticker), ticker, f.source))];
    const results = await Promise.allSettled(tasks);
    const merged: NewsItem[] = [];
    results.forEach((r, i) => {
      const via = i === 0 ? "google" : TICKER_FEEDS[i - 1]!.via;
      if (r.status === "fulfilled") merged.push(...r.value);
      else metrics.count(`news.${via}`, false, r.reason instanceof Error ? r.reason.message : String(r.reason));
    });
    return dedupe(
      merged.filter((x) => isRelevant(x, ticker, name)).sort((a, b) => b.publishedAt - a.publishedAt),
      40,
    );
  });
  return all.slice(0, limit);
}

/** Mixed feed across tickers (a few per ticker), de-duplicated across tickers, newest first. */
export async function getMarketNews(tickers: Array<{ ticker: string; name: string }>, perTicker = 2, limit = 12): Promise<NewsItem[]> {
  const lists = await Promise.all(tickers.map((t) => getNews(t.ticker, t.name, Math.max(perTicker, 6)).catch(() => [] as NewsItem[])));
  const merged = lists.flatMap((l) => l.slice(0, perTicker)).sort((a, b) => b.publishedAt - a.publishedAt);
  return dedupe(merged, limit);
}

/** Market-wide business headlines (CNBC, MarketWatch, WSJ, Investing.com), newest first. */
export async function getMarketWideNews(limit = 20): Promise<NewsItem[]> {
  const all = await cached("news:markets", { ttlMs: 15 * 60_000, staleMs: 6 * 60 * 60_000 }, async () => {
    const results = await Promise.allSettled(MARKET_FEEDS.map((f) => feed(f.via, f.url, "MARKETS", f.source)));
    const merged: NewsItem[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") merged.push(...r.value.slice(0, 12));
      else metrics.count(`news.${MARKET_FEEDS[i]!.via}`, false, r.reason instanceof Error ? r.reason.message : String(r.reason));
    });
    return dedupe(
      merged.sort((a, b) => b.publishedAt - a.publishedAt),
      40,
    );
  });
  return all.slice(0, limit);
}

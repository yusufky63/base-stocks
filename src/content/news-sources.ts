/** Publishers behind the headlines feed (all keyless RSS). Shared by the server fetcher and the News page. */
export type NewsVia = "google" | "yahoo" | "nasdaq" | "seekingalpha" | "cnbc" | "marketwatch" | "wsj" | "investing" | "ecosystem";

export interface NewsSource {
  id: NewsVia;
  label: string;
  /** "ticker" feeds are fetched per stock; "market" feeds are market-wide; "ecosystem" follows tokenized stocks on Base and Coinbase's listings. */
  scope: "ticker" | "market" | "ecosystem";
  homepage: string;
  note: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  { id: "ecosystem", label: "Base & Coinbase", scope: "ecosystem", homepage: "https://base.org", note: "Google News searches for tokenized stocks on Base and Coinbase's stock listings — Base.org and Coinbase posts, exchange and crypto press. Spotlighted in the brief." },
  { id: "google", label: "Google News", scope: "ticker", homepage: "https://news.google.com", note: "Aggregates hundreds of outlets; query scoped to the company and ticker." },
  { id: "yahoo", label: "Yahoo Finance", scope: "ticker", homepage: "https://finance.yahoo.com", note: "Per-ticker wire; filtered for relevance." },
  { id: "nasdaq", label: "Nasdaq", scope: "ticker", homepage: "https://www.nasdaq.com", note: "Per-symbol feed; market-wide items filtered out." },
  { id: "seekingalpha", label: "Seeking Alpha", scope: "ticker", homepage: "https://seekingalpha.com", note: "News and analysis for the symbol." },
  { id: "cnbc", label: "CNBC", scope: "market", homepage: "https://www.cnbc.com", note: "Top business news." },
  { id: "marketwatch", label: "MarketWatch", scope: "market", homepage: "https://www.marketwatch.com", note: "Top stories." },
  { id: "wsj", label: "WSJ Markets", scope: "market", homepage: "https://www.wsj.com/news/markets", note: "Markets desk." },
  { id: "investing", label: "Investing.com", scope: "market", homepage: "https://www.investing.com", note: "Stock market news." },
];

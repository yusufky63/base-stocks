import { describe, expect, it } from "vitest";
import { isEcosystemHeadline, parseRss, tickersMentioned } from "./news-service";

const TICKERS = ["NVDA", "AAPL", "GOOGL", "COIN", "MSTR", "TSLA"];

describe("what counts as an ecosystem headline", () => {
  it("recognises Coinbase's listings and tokenized stocks under their usual names", () => {
    expect(isEcosystemHeadline("Coinbase adds six tokenized stocks after $228M debut")).toBe(true);
    expect(isEcosystemHeadline("Coinbase Debuts Tokenized Stocks On Base Network")).toBe(true);
    expect(isEcosystemHeadline("Stocks just got updated.")).toBe(false);
    expect(isEcosystemHeadline("Tokenised equities volume on Base tops $1B")).toBe(true);
    expect(isEcosystemHeadline("What the B20 standard means for issuers")).toBe(true);
    expect(isEcosystemHeadline("xStocks expand to another chain")).toBe(true);
  });

  /** Coinbase the exchange is in the news every day; only its listings belong here. */
  it("does not take every Coinbase story for a listing story", () => {
    expect(isEcosystemHeadline("Ondo Joins Perps Race Against Hyperliquid, Coinbase — Protocol Volume Clears $100 Million")).toBe(false);
    expect(isEcosystemHeadline("Coinbase Q3 earnings beat estimates")).toBe(false);
    expect(isEcosystemHeadline("Coinbase lists Amazon, Tesla and SpaceX on Base")).toBe(true);
    expect(isEcosystemHeadline("Coinbase stock tokens generate $228M in DEX trading volume")).toBe(true);
  });

  /** "Base" the chain has to be told apart from "base" the word. */
  it("does not mistake the ordinary word base for the chain", () => {
    expect(isEcosystemHeadline("Fed holds base rate steady")).toBe(false);
    expect(isEcosystemHeadline("Apple grows its customer base in India")).toBe(false);
    expect(isEcosystemHeadline("Database outage hits trading app")).toBe(false);
    expect(isEcosystemHeadline("Nvidia stock hits record")).toBe(false);
    expect(isEcosystemHeadline("Base network stock trading passes a new milestone")).toBe(true);
  });
});

describe("tickers a headline names", () => {
  it("matches tickers and their aliases", () => {
    expect(tickersMentioned("Nvidia and Alphabet lead tokenized stock volume on Base", TICKERS)).toEqual(["NVDA", "GOOGL"]);
    expect(tickersMentioned("Tesla's Musk on the record", TICKERS)).toEqual(["TSLA"]);
  });

  /** Coinbase the venue appears in most ecosystem headlines; that is not news about COIN the stock. */
  it("does not read Coinbase the venue as COIN the stock", () => {
    expect(tickersMentioned("Coinbase Debuts Tokenized Stocks On Base Network", TICKERS)).toEqual([]);
    expect(tickersMentioned("COIN shares rise after tokenized stock launch", TICKERS)).toEqual(["COIN"]);
  });
});

describe("rss parsing", () => {
  it("reads items with their publisher and drops entries without a real link", () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Coinbase adds &amp; expands]]></title><link>https://example.com/a</link><pubDate>Fri, 05 Sep 2026 10:00:00 GMT</pubDate><source url="https://x">Crypto News</source></item>
      <item><title>No link here</title></item>
      <item><title>Relative link</title><link>/local</link></item>
    </channel></rss>`;
    const items = parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Coinbase adds & expands", link: "https://example.com/a", source: "Crypto News" });
  });
});

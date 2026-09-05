import { describe, expect, it } from "vitest";
import { isEcosystemHeadline, parseRss, parseXDate, parseXTimeline, tickersMentioned } from "./news-service";

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

describe("posts from X", () => {
  it("reads X's legacy date format, offset included", () => {
    expect(parseXDate("Thu Sep 03 11:53:36 +0000 2026")).toBe(Date.UTC(2026, 8, 3, 11, 53, 36));
    expect(parseXDate("Thu Sep 03 11:53:36 +0300 2026")).toBe(Date.UTC(2026, 8, 3, 8, 53, 36));
    expect(parseXDate("nonsense")).toBe(0);
  });

  /** Replies to other people are conversation; a thread under one's own post is still the announcement. */
  it("turns the embed page's timeline into posts, dropping replies to others and expanding links", () => {
    const data = {
      props: {
        pageProps: {
          timeline: {
            entries: [
              { type: "tweet", content: { tweet: { id_str: "1", created_at: "Thu Sep 03 11:53:36 +0000 2026", full_text: "Six more tokenized stocks are live on Base https://t.co/abc https://t.co/pic", permalink: "/base/status/1", user: { screen_name: "base" }, entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://base.org/stocks" }], media: [{ url: "https://t.co/pic" }] } } } },
              { type: "tweet", content: { tweet: { id_str: "2", created_at: "Thu Sep 03 12:00:00 +0000 2026", full_text: "@someone thanks!", in_reply_to_screen_name: "someone", user: { screen_name: "base" } } } },
              { type: "tweet", content: { tweet: { id_str: "3", created_at: "Thu Sep 03 12:10:00 +0000 2026", full_text: "2/ and the thread goes on", in_reply_to_screen_name: "base", user: { screen_name: "base" } } } },
            ],
          },
        },
      },
    };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
    const posts = parseXTimeline(html, "base");
    expect(posts.map((p) => p.id)).toEqual(["x:1", "x:3"]);
    expect(posts[0]).toMatchObject({ title: "Six more tokenized stocks are live on Base https://base.org/stocks", url: "https://x.com/base/status/1", source: "@base", ticker: "X", via: "x", spotlight: true, publishedAt: Date.UTC(2026, 8, 3, 11, 53, 36) });
    expect(posts[1]!.url).toBe("https://x.com/base/status/3");
  });

  it("gives nothing for a page without timeline data", () => {
    expect(parseXTimeline("<html></html>", "base")).toEqual([]);
    expect(parseXTimeline('<script id="__NEXT_DATA__" type="application/json">{oops</script>', "base")).toEqual([]);
  });
});

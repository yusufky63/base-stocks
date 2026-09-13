import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Coins, Globe, Zap } from "lucide-react";
import { V1_CAVEATS, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import { PRO_PRICE_USD, paymentInfo } from "@/lib/api-v1/x402";
import { Module, ModuleHeader, PageTitle } from "@/components/ui/primitives";
import { EndpointCard } from "@/components/developers/EndpointCard";
import { Cell, SectionHead } from "@/components/common/DocSection";

export const metadata: Metadata = pageMeta({
  title: "API",
  description: "A public, read-only API for Coinbase Tokenized Stocks on Base: prices, Chainlink references, liquidity, news, USDC yield venues and wallet positions. No key, open CORS, and two paid endpoints priced per call in USDC over x402.",
  path: "/developers",
});

/** Revalidated hourly: the page is a document, and the live parts are fetched by the reader. */
export const revalidate = 3600;

export default function DevelopersPage() {
  const pay = paymentInfo();
  const free = V1_ENDPOINTS.filter((e) => !e.paid);
  const paid = V1_ENDPOINTS.filter((e) => e.paid);

  return (
    <div className="flex flex-col gap-8">
      <PageTitle
        index="09 — API"
        title="Build on the same data."
        lead="Everything this app shows about tokenized stocks on Base, as a public read-only API. No key, no account, open CORS — and every example on this page runs against the live deployment."
      />

      <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
        <Cell icon={Globe} title="Open by default">
          Plain GET requests, no key and no headers. Any origin may call it from a browser; any agent may read it from a chat.
        </Cell>
        <Cell icon={Zap} title="Cached at the edge">
          Each response declares how long it may be reused, and the CDN honours it. A thousand readers cost the app the same as one.
        </Cell>
        <Cell icon={Coins} title="Paid where work is real">
          Two endpoints back a model call or a heavy upstream read. Those cost {PRO_PRICE_USD} in USDC per call over x402; everything else is free.
        </Cell>
      </div>

      <section className="flex flex-col gap-4">
        <SectionHead n={1} id="start" title="Start here" sub="one request, no setup" />
        <Module>
          <div className="p-4 flex flex-col gap-3">
            <pre className="rounded-[6px] border border-line bg-surface p-3 font-mono text-[12px] overflow-x-auto">curl -s &quot;https://basestocks.finance/api/v1/stocks/NVDA&quot;</pre>
            <p className="text-[13px] text-ink-secondary leading-relaxed">
              Every response is <code className="font-mono text-[12px]">{"{ data, meta }"}</code>. <code className="font-mono text-[12px]">meta.cacheSeconds</code> tells you how long the body stays valid, so a
              polling client knows exactly how often it is worth asking again.
            </p>
            <div className="flex flex-wrap gap-2 text-[13px]">
              <Link href="/api/v1" className="text-primary font-medium inline-flex items-center gap-1">
                Endpoint index <ArrowUpRight size={13} strokeWidth={1.75} />
              </Link>
              <span className="text-ink-muted">·</span>
              <Link href="/api/v1/openapi.json" className="text-primary font-medium inline-flex items-center gap-1">
                OpenAPI 3.1 <ArrowUpRight size={13} strokeWidth={1.75} />
              </Link>
              <span className="text-ink-muted">·</span>
              <Link href="/llms.txt" className="text-primary font-medium inline-flex items-center gap-1">
                llms.txt <ArrowUpRight size={13} strokeWidth={1.75} />
              </Link>
            </div>
          </div>
        </Module>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={2} id="read-first" title="Read this before using the numbers" sub="four ways to get B20 wrong" />
        <p className="text-[14px] text-ink-secondary max-w-[80ch] leading-relaxed">
          Tokenized stocks are not ordinary ERC-20s, and three of these have caught people out. The API returns each of them explicitly rather than leaving you to infer it.
        </p>
        <div className="module-grid grid-cols-1 md:grid-cols-2 ticks">
          {V1_CAVEATS.map((c) => (
            <div key={c.title} className="p-4 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} strokeWidth={1.75} className="text-warning-fg shrink-0" />
                <span className="text-[14px] font-medium">{c.title}</span>
              </div>
              <p className="text-[13px] text-ink-secondary leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={3} id="free" title="Free endpoints" sub="no key, open CORS" />
        <div className="flex flex-col gap-4">
          {free.map((e) => (
            <EndpointCard key={e.path} endpoint={e} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={4} id="paid" title="Paid endpoints" sub={`${PRO_PRICE_USD} in USDC per call`} />
        <Module>
          <ModuleHeader title="How x402 works here" />
          <div className="p-4 flex flex-col gap-3 text-[13px] text-ink-secondary leading-relaxed">
            <p>
              Call the endpoint. It answers <code className="font-mono text-[12px] text-ink">402 Payment Required</code> with the amount, the asset, the network and the recipient. Your client signs a
              USDC authorization, retries the same URL, and gets the body. Nothing to sign up for and no key to rotate.
            </p>
            <p>
              Settlement happens <span className="text-ink font-medium">after</span> a successful response, so a request that fails or asks for an unknown stock never costs anything.
            </p>
            <div className="border border-line rounded-[6px] overflow-hidden">
              {[
                ["Price", `${PRO_PRICE_USD} per call`],
                ["Asset", "USDC"],
                ["Network", pay.network === "base" ? "Base mainnet (8453)" : "Base Sepolia (84532) — mainnet once a production facilitator is configured"],
                ["Status", pay.enabled ? "Live" : "Open while no recipient is configured on this deployment"],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-x-4 px-3 py-2 border-b border-line last:border-b-0">
                  <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted pt-0.5">{k}</div>
                  <div className="text-[13px] text-ink">{v}</div>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-ink-muted">
              x402 is Coinbase&apos;s HTTP payment standard.{" "}
              <a href="https://docs.base.org/build-on-base/accept-payments/charge-for-an-api" target="_blank" rel="noopener noreferrer" className="text-primary">
                Base&apos;s guide
              </a>{" "}
              covers the buyer side, including how an agent pays autonomously.
            </p>
          </div>
        </Module>
        <div className="flex flex-col gap-4">
          {paid.map((e) => (
            <EndpointCard key={e.path} endpoint={e} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={5} id="agents" title="For agents" sub="works in a chat, not just a terminal" />
        <Module>
          <div className="p-4 flex flex-col gap-3 text-[13px] text-ink-secondary leading-relaxed">
            <p>
              Everything here is a plain GET with the parameters in the URL, which is what an assistant inside Claude, ChatGPT or Perplexity can actually fetch — and what a person can open in a tab and
              paste back when it cannot. <Link href="/llms.txt" className="text-primary">llms.txt</Link> is the one-fetch index of what exists.
            </p>
            <p>
              Ask your assistant: <span className="text-ink">&ldquo;Read https://basestocks.finance/llms.txt and tell me which tokenized stock on Base has the deepest liquidity right now.&rdquo;</span>
            </p>
          </div>
        </Module>
      </section>

      <p className="text-[12px] text-ink-muted max-w-[80ch] leading-relaxed">
        Coinbase tokenized stocks are available only to eligible persons outside the United States. This API reports public chain data and does not offer or execute a trade. Prices and rates change; the
        app publishes what it reads and marks what it could not.
      </p>
    </div>
  );
}

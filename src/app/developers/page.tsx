import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import { AlertTriangle, ArrowUpRight, Coins, Globe, Repeat } from "lucide-react";
import { V1_CAVEATS, V1_ENDPOINTS, V1_GROUPS, apiRules, endpointsIn } from "@/lib/api-v1/catalog";
import { exampleRequest, curlOf } from "@/lib/api-v1/try";
import { tradeExample } from "@/lib/api-v1/llms";
import { PRO_PRICE_USD, paymentInfo } from "@/lib/api-v1/x402";
import { publicEnv } from "@/config/env";
import { Module, ModuleHeader, PageTitle } from "@/components/ui/primitives";
import { EndpointCard } from "@/components/developers/EndpointCard";
import { CopyBlock } from "@/components/developers/CopyBlock";
import { Cell, SectionHead } from "@/components/common/DocSection";

export const metadata: Metadata = pageMeta({
  title: "API",
  description:
    "A public API for Coinbase Tokenized Stocks on Base: prices, Chainlink references, liquidity, news, USDC yield venues, wallet positions, and the calls to buy or sell a stock. No key, open CORS, two paid endpoints over x402, an OpenAPI spec and llms.txt.",
  path: "/developers",
});

/** Revalidated hourly: the page is a document, and the live parts are fetched by the reader. */
export const revalidate = 3600;

/** The sections before the endpoint groups; the groups follow in catalog order. */
const INTRO = [
  { id: "start", title: "Start here", sub: "configuration and a first request" },
  { id: "read-first", title: "Read this before using the numbers", sub: `${V1_CAVEATS.length} ways to get B20 wrong` },
  { id: "agents", title: "For AI and tools", sub: "the same reference, machine-readable" },
] as const;

/**
 * Group anchors. The pro group keeps its old one, #paid, which other pages and posts link to; the
 * trade group takes #trading, since #trade is the trade endpoint's own card.
 */
const groupAnchor = (id: string) => (id === "pro" ? "paid" : id === "trade" ? "trading" : id);

export default function DevelopersPage() {
  const pay = paymentInfo();
  const base = publicEnv.appUrl.replace(/\/$/, "");
  const firstRequest = curlOf(exampleRequest(V1_ENDPOINTS.find((e) => e.id === "stock")!, base));
  const resources = [
    { href: "/llms.txt", title: "llms.txt", text: "The short index an assistant reads first: what exists and where." },
    { href: "/llms-full.txt", title: "llms-full.txt", text: "This whole reference in one text file: conventions, every parameter and error, curl lines, the trade example." },
    { href: "/api/v1/openapi.json", title: "OpenAPI 3.1", text: "Typed parameters and the trade body, for Swagger, Postman, a code generator or an agent's tool definitions." },
    { href: "/api/v1", title: "Endpoint index", text: "The catalog itself as JSON, with the payment details and the caveats." },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageTitle
        index="09 — API"
        title="Build on the same data."
        lead="Everything this app shows about tokenized stocks on Base, and the calls to trade them, as a public API. No key, no account, open CORS — and every endpoint on this page has a Try it that runs against the live deployment."
      />

      <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
        <Cell icon={Globe} title="Open by default">
          No key and no account. Any origin may call it from a browser; any agent may read it from a chat. Reads are cached at the edge, so a thousand readers cost the app what one does.
        </Cell>
        <Cell icon={Repeat} title="Trades your user signs">
          One POST returns the approval and the swap for a buy or a sell, from the router the app trades with. The user&apos;s own wallet signs and sends them; nothing is held for anyone.
        </Cell>
        <Cell icon={Coins} title="Paid where work is real">
          Two endpoints back a model call or a heavy upstream read. Those cost {PRO_PRICE_USD} in USDC per call over x402; everything else is free.
        </Cell>
      </div>

      <nav aria-label="API sections" className="flex flex-wrap gap-1.5">
        {[...INTRO.map((s) => ({ id: s.id, title: s.title })), ...V1_GROUPS.map((g) => ({ id: groupAnchor(g.id), title: g.title }))].map((s, i) => (
          <a key={s.id} href={`#${s.id}`} className="rail inline-flex items-center gap-2 h-8 px-3 rounded-[6px] border border-line text-[12px] text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
            <span className="font-mono text-[10px] text-primary">{String(i + 1).padStart(2, "0")}</span>
            {s.title}
          </a>
        ))}
      </nav>

      <section className="flex flex-col gap-4">
        <SectionHead n={1} id={INTRO[0].id} title={INTRO[0].title} sub={INTRO[0].sub} />
        <Module>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse">
              <tbody className="divide-y divide-line">
                {apiRules(base).map((rule) => (
                  <tr key={rule.label} className="align-top">
                    <th scope="row" className="py-2.5 px-4 w-[140px] text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted font-normal">
                      {rule.label}
                    </th>
                    <td className="py-2.5 pr-4 text-[13px] text-ink">{rule.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Module>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <CopyBlock label="A first request" code={firstRequest} />
          <CopyBlock label="A trade, in your app" code={tradeExample(base)} />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={2} id={INTRO[1].id} title={INTRO[1].title} sub={INTRO[1].sub} />
        <p className="text-[14px] text-ink-secondary max-w-[80ch] leading-relaxed">
          Tokenized stocks are not ordinary ERC-20s, and these have caught people out. The API returns each of them explicitly rather than leaving you to infer it.
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
        <SectionHead n={3} id={INTRO[2].id} title={INTRO[2].title} sub={INTRO[2].sub} />
        <div className="module-grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {resources.map((r) => (
            <a key={r.href} href={r.href} target="_blank" rel="noreferrer" className="rail p-4 flex flex-col gap-2 min-w-0 hover:bg-surface transition-fast">
              <span className="flex items-center justify-between gap-2 text-[15px] font-medium">
                {r.title} <ArrowUpRight size={14} strokeWidth={1.75} className="text-ink-muted" />
              </span>
              <span className="text-[13px] text-ink-secondary leading-relaxed">{r.text}</span>
              <code className="font-mono text-[11px] text-ink-muted truncate">{`${base}${r.href}`}</code>
            </a>
          ))}
        </div>
        <p className="text-[13px] text-ink-secondary max-w-[80ch] leading-relaxed">
          Ask your assistant: <span className="text-ink">&ldquo;Read {base}/llms-full.txt and tell me which tokenized stock on Base has the deepest liquidity right now.&rdquo;</span> The reads are plain
          GETs an assistant inside a chat can fetch; the trade builder is a POST for an app or an agent with a wallet.
        </p>
      </section>

      {V1_GROUPS.map((group, g) => (
        <section key={group.id} className="flex flex-col gap-4">
          <SectionHead n={INTRO.length + g + 1} id={groupAnchor(group.id)} title={group.title} sub={`${endpointsIn(group.id).length} endpoint${endpointsIn(group.id).length === 1 ? "" : "s"}`} />
          <p className="text-[14px] text-ink-secondary max-w-[80ch] leading-relaxed">{group.intro}</p>
          {group.id === "pro" && (
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
          )}
          <div className="flex flex-col gap-4">
            {endpointsIn(group.id).map((e) => (
              <EndpointCard key={e.id} endpoint={e} base={base} />
            ))}
          </div>
        </section>
      ))}

      <p className="text-[12px] text-ink-muted max-w-[80ch] leading-relaxed">
        Coinbase tokenized stocks are available only to eligible persons outside the United States. This API reports public chain data and builds calls for the user&apos;s own wallet; it never signs,
        sends or executes a trade. Prices and rates change; the app publishes what it reads and marks what it could not.
      </p>
    </div>
  );
}

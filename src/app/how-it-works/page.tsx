import type { Metadata } from "next";
import { pageMeta } from "@/lib/page-meta";
import Link from "next/link";
import { BarChart3, Blocks, Bot, Boxes, Code2, CreditCard, Gift, Landmark, LineChart, Newspaper, PieChart, Repeat, ShieldCheck, Sprout, Users } from "lucide-react";
import { LinkButton } from "@/components/ui/primitives";
import { LegalNotice } from "@/components/common/display";
import { IntegrationsSection } from "@/components/common/Integrations";
import { Dither } from "@/components/fx/lazy";
import { DocSearch, type DocEntry } from "@/components/common/DocSearch";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";

const STOCK_COUNT = CURATED_B20_ASSETS.length;

export const metadata: Metadata = pageMeta({ title: "How it works", path: "/how-it-works" });

const FEATURES = [
  { icon: LineChart, title: "Markets", body: `${STOCK_COUNT} Coinbase Tokenized Stocks with live DEX price, Chainlink reference, candles, volume, liquidity and a Live / Thin / Very thin / No pool / Not issued status.`, href: "/markets" },
  { icon: BarChart3, title: "Trade", body: "Every quote asks KyberSwap, Velora, Uniswap, Aerodrome and, when enabled, 0x and OKX at once; you pick auto (best net) or a provider, including gasless CoW signed orders (0x joins outside the US, where its API serves). Limit orders at your own price. Pay with USDC or ETH.", href: "/markets" },
  { icon: Blocks, title: "Build", body: "Baskets from sliders or templates, previewed with live quotes, executed leg by leg. Not-issued names stay as USDC or spread across live ones.", href: "/build" },
  { icon: Repeat, title: "Automate", body: "A stock or a basket bought on a schedule. Automatic plans run through the AutoInvest contract within limits the chain enforces — amount, cadence, routes, minimum output — and can be paused, cancelled or revoked any time; or keep a plan that waits for your confirmation per run.", href: "/automate" },
  { icon: CreditCard, title: "Add funds", body: "Card, Apple Pay or Google Pay through Coinbase Onramp, buying USDC straight into your own wallet on Base. Or withdraw from an exchange, bridge from another chain, or receive by address. Nothing is held on the way.", href: "/portfolio" },
  { icon: Sprout, title: "Earn", body: "Idle USDC into Morpho vaults, Aave V3 and Compound v3 from here. Stock venues, pools and your LP positions are discovered, not hardcoded.", href: "/earn" },
  { icon: Gift, title: "Send & gift", body: "To a Basename or address, or a claim link (single or a batch) for someone without a wallet: the stock waits in an ownerless escrow until they claim it with a passkey.", href: "/gifts" },
  { icon: Boxes, title: "Gift pools", body: "One deposit, many equal shares. Ten people take 10% each, a package of several stocks pays out in one claim, and whatever nobody claims comes back to you. Optional steps first: a Basename, a purchase, a follow on X.", href: "/pools" },
  { icon: PieChart, title: "Portfolio", body: "Value, allocation, history, LP positions, activity with onchain verification, rebalance against a template, daily AI summary.", href: "/portfolio" },
  { icon: Users, title: "Community", body: "Published baskets, votes, clones, public pages under your Basename, badges. Templates, not recommendations.", href: "/community" },
  { icon: Newspaper, title: "News & brief", body: "Headlines per stock and market-wide, a Base & Coinbase feed that follows tokenized-stock listings and venues, and one shared AI brief every six hours that reads about sixty headlines and leads with that ecosystem.", href: "/news" },
  { icon: Bot, title: "Copilot, fenced", body: "Ask in your own words on any page: prices, news, your portfolio, Earn, plans, gift pools. Say what you want done — buy $50 of NVDA, build a tech basket, invest weekly — and it prepares a draft you review and sign in your own wallet. It cannot sign, approve, execute or pick addresses, it only knows this app, and it explains rather than recommends.", href: "/how-it-works#faq" },
  {
    icon: Code2,
    title: "Public API",
    body: "The same data, as a read-only API: prices, Chainlink references, liquidity, headlines, USDC yield venues and any wallet's position. No key, no account, open to any origin. Two heavier endpoints cost ten cents in USDC per call over x402.",
    href: "/developers",
  },
  { icon: Landmark, title: "Compliance", body: "Eligibility notice for restricted regions, issuer policies and pauses read before every action, plain-language errors.", href: "/how-it-works#faq" },
  { icon: ShieldCheck, title: "Status", body: "Live checks of the chain, price feeds, trading routes, yield venues, news and storage this app depends on.", href: "/status" },
];

const STEPS = [
  { n: "01", title: "Find", body: `${STOCK_COUNT} Coinbase Tokenized Stocks live on Base as B20 tokens. BStocks identifies each one by its contract address, never by ticker, because names and symbols can change onchain.`, detail: "Assets are read straight from the chain: name, decimals, multiplier, transfer policy, pause flags, supply. New B20 tokens from Coinbase's deployer are discovered automatically." },
  { n: "02", title: "Understand", body: "You see one price and trade at it: the pool's. The issuer's Chainlink feed is what that price is checked against: it is priced from traditional market data and cannot be moved by opening a pool, so when a pool disagrees with it the reference is shown instead and labelled. Executable is what a live quote gives you for your exact amount." },
  { n: "03", title: "Buy or sell", body: "Pick an amount, compare providers, review a firm quote (price, impact, network fee), confirm in your wallet. Quotes are fetched server-side; keys never touch your browser.", detail: "Approvals are scoped to the exact amount and granted only to the spender the provider returns. Every transaction is simulated before it is sent." },
  { n: "04", title: "Hold", body: "Tokens sit in your wallet, not with BStocks. Issuer policies and pauses are read before every action and explained in plain language if they block a transfer.", detail: "Corporate actions (dividends, splits) show up as multiplier changes and reference-price freezes, never as invented cash events." },
  { n: "05", title: "Build & automate", body: "Compose a basket from an AI draft, a template or stocks you tap; it is kept on your device as you go. USDC is approved once for the whole basket: a wallet that batches (Base Account) confirms every purchase in one go, any other confirms them one by one. If a leg fails, the completed ones stay and you can retry the rest.", detail: "Plans repeat a buy or a basket on a schedule. An automatic plan runs by itself: the contract pulls one run's USDC under an allowance you set, swaps it with you as the recipient and checks what you received against the Chainlink reference. A manual plan proposes a run and waits for your wallet." },
  { n: "06", title: "Send or earn", body: "Send stock to a Basename like alice.base.eth or a 0x address; the resolved address is always shown before you confirm. Earn venues are discovered at runtime and hidden when none exist.", detail: "USDC deposits into Morpho, Aave V3 and Compound v3 run in-app; USDC pools open right here from a USD price range, and positions, fees, collect and withdraw live here too." },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "What is a Coinbase Tokenized Stock?", a: "An ERC-20 token on Base issued by Coinbase under the B20 standard, backed one-to-one by the underlying share held by the issuer. Dividends and splits are reflected through an onchain multiplier, so one token can equal more or less than one share over time." },
  { q: "Why does a stock say “not issued yet”?", a: "The contract exists on Base but Coinbase has not minted any tokens, so there is no supply, no pool and no route that can fill an order. It becomes tradable automatically the moment supply appears; add it to your watchlist meanwhile." },
  { q: "Who can trade here?", a: "Coinbase Tokenized Stocks are offered to eligible persons outside the United States. Visitors from restricted regions see an eligibility notice and must confirm they are eligible before trading; browsing prices, charts and news stays open to everyone." },
  { q: "Where do prices come from?", a: "Market price and liquidity come from the primary DEX pool (DexScreener, GeckoTerminal), and only from a pool quoted in USDC or ETH: a pool prices a stock against whatever is on the other side, so a pair quoted in some other token reports that token's valuation rather than the stock's. The pool price is then checked against the reference, and refused as the headline figure if it disagrees with it while the feed is live. The reference price is the Chainlink total-return feed for the stock, shown with a freshness flag (live, last close, stale, frozen). The executable price is the live quote from the provider you trade with." },
  { q: "Who executes my trade?", a: "Every quote is requested from several routes at once: KyberSwap, Velora, the Uniswap Trading API, Aerodrome directly, and 0x or OKX when they are enabled. BStocks shows every answer, picks the best net output by default, and lets you choose a provider. The swap itself is a transaction your wallet signs. Turn on best execution and CoW Protocol's batch auction takes the trade whenever it is within half a percent of the best swap: no gas, no front-running, and the panel suggests it for larger orders." },
  { q: "Do I need ETH on Base to use this?", a: "Often not. With a Base Account (passkey wallet), gas is sponsored by a paymaster where its policy allows \u2014 trades, earn deposits, liquidity actions and gift claims can all run with zero ETH; a declined sponsorship just means your wallet asks you to pay instead. Classic wallets pay the Base network fee themselves, usually under a cent. CoW limit orders need no gas to place or cancel, and gift claims can even be paid by someone else entirely." },
  { q: "What fees do I pay?", a: "The Base network fee (usually cents), any DEX fee inside the quoted price, and any provider fee shown in the quote. BStocks charges nothing itself. Base Account users may get sponsored gas when a paymaster is configured." },
  { q: "Is BStocks custodial?", a: "No. Tokens stay in your wallet, approvals are limited to the exact amount and spender, and nothing is signed on page load. An automatic plan draws on a USDC allowance you set and can revoke; the contract never holds your stock. BStocks stores records (trades, gifts, plans, profiles) offchain to explain what happened, never keys or funds." },
  { q: "Can I pay with ETH?", a: "Yes. Choose “Pay with ETH” in the trade panel and the route swaps ETH already on Base; no bridge is needed. USDC remains the default settlement asset." },
  {
    q: "How do I get USDC on Base?",
    a: "From Add funds, on the Portfolio page or inside any Buy panel. The quickest path is a card, Apple Pay or Google Pay through Coinbase Onramp: the USDC lands straight in your own wallet on Base, and nothing is held on the way. You can also withdraw USDC on the Base network from Coinbase or another exchange to the address shown there, bridge or swap from another chain with LI.FI, or receive from any wallet by address or QR. A Base Account can also draw from a Coinbase balance at the moment you confirm a trade.",
  },
  {
    q: "Do I need any crypto to start?",
    a: "No. A Base Account is created with a passkey, so there is no seed phrase and no extension. Gas is sponsored by the paymaster, so you never have to hold ETH. And a card or Apple Pay buys the USDC directly into that wallet. Starting from nothing, the whole path to owning a tokenized stock happens inside the app.",
  },
  { q: "What does the assistant do, and what can it not do?", a: "Copilot answers questions from live data — prices, your portfolio and activity, Earn, limit orders, gifts, gift pools, templates, community activity, platform statistics, service status and headlines — and prepares drafts: a swap, a basket, a recurring plan, a gift, an Earn deposit. Every draft appears as a card you review; it becomes real only when you sign it in your own wallet. It cannot sign, approve, move funds, pick contract addresses or execute anything. It answers only about this app and its listed stocks, states no figure it did not just read from the app, and gives no advice or predictions. It also writes the shared market brief and, on request, a daily summary of your portfolio." },
  { q: "What data does the assistant see?", a: "Only what the app itself can read, and only when a question calls for it: the listed stocks with the same Live / Thin / No pool status Markets shows, prices, 24h moves and DEX liquidity; the shared market brief; headline titles; and — when a wallet is connected — that wallet’s public onchain positions, activity, orders, gifts and LP positions. It never sees your keys, and it is never given contract addresses or transaction data to write. A basket draft comes with a short commentary — why each leg, what could go against the mix, which headlines it leaned on — that explains, never recommends. For the market brief: about sixty headlines (per stock, market desks, and a Base & Coinbase feed that follows tokenized-stock listings and venues) and prices; it leads with that ecosystem. For your daily summary: your onchain balances, last-24h activity and headlines about held stocks, sent only when you ask." },
  { q: "Can I add liquidity from here?", a: "Yes, for USDC pools on Uniswap v3 and Aerodrome Slipstream: open a pool from a stock's Earn tab, pick a price range in USD per share, and both deposit amounts are derived for you — simulated before your wallet opens, exact approvals only. Collecting fees and withdrawing also run in-app; other pool types still open on the venue while positions stay tracked here." },
  { q: "How do limit orders work?", a: "A limit order is an EIP-712 message you sign, not a transaction: it waits in the CoW Protocol order book until a solver can fill it at your price or better (partial fills allowed), for up to three hours. The solver pays the gas; fees come out of the difference to the market price. Cancel any time from Your orders — free for regular wallets, a small transaction for smart accounts." },
  { q: "What is a claim-link gift?", a: "A way to gift stock to someone without a wallet. The stock moves into an ownerless escrow contract; the link you share carries the claim key in its fragment, which never reaches any server. Whoever opens the link creates a passkey wallet (or connects one) and claims — gas sponsored where the paymaster allows. You can cancel unclaimed links any time, and they expire on their own." },
  { q: "What is a gift pool?", a: "One deposit that many people can claim an equal share of. You say how much goes in and how many people it is for; the contract holds it and pays each claimer exactly one share, one per wallet. A pool can hold several stocks at once, so a claim delivers a small package rather than a single name. Share it as a link, list it publicly, or put steps in front of it. Nothing rounds: the share is fixed when you create the pool, so there is never a last person who gets less." },
  { q: "Can I get a gift pool back?", a: "Yes, at any time. Closing a pool stops new claims immediately and returns everything unclaimed to your wallet; shares already taken stay with the people who took them." },
  { q: "Do the tasks on a pool actually get checked?", a: "Some of them, and the app always tells you which. Owning a Basename, holding a stock and having bought one are read from Base — a purchase is re-read from its transaction receipt, so it cannot be faked. The rest are different: a follow, a repost, a like or a visit to a page cannot be checked by anyone from outside, so they are recorded as the claimant's own confirmation, with their wallet and a timestamp, and shown as “declared” rather than verified on the creator's list. A pool can ask for up to eight steps and repeat them — several accounts to follow, several links to read — but pair at least one with an onchain step if a campaign has to hold up." },
  { q: "How does auto-invest work, and what can it not do?", a: "You create a plan onchain: which stocks, in what mix, how much USDC per run, how often, for how long, and how far below the Chainlink reference a fill may land. You approve a USDC allowance for it. When a run is due, a keeper run by BStocks (or you, from your wallet) triggers it: the contract pulls exactly one run's USDC, swaps it through an allow-listed route with your wallet as the recipient, and reverts the whole run if you would receive less than allowed. It can never take more than the amount per run, never run more often than the cadence, never send stock anywhere but to you, and never sell. Pause, cancel or revoke the allowance at any time." },
  { q: "What if a stock in my plan cannot be bought one week?", a: "That leg is skipped for that run — its share simply stays in your wallet — and the plan keeps its schedule. The same rule that labels a stock Not issued, No pool or Paused on Markets decides this, and a leg that would be more than 2% of its pool is skipped too rather than filled at a bad price. An automatic plan also skips a leg whose pool price sits above the Chainlink reference by more than the plan's tolerance: the contract will not pay a premium on your behalf, and the wizard says so before you create the plan." },
  {
    q: "Is there an API I can build on?",
    a: "Yes. Everything this app shows about tokenized stocks is a public, read-only API at /api/v1 — plain GET requests, no key, no account, and CORS open to every origin, so a browser, a script or an assistant in a chat can all read it. Six endpoints are free: every listed stock with its DEX price, Chainlink reference, liquidity, 24h volume and multiplier; one stock with the pools that trade it; headlines; USDC yield venues; any wallet's tokenized-stock position read from the chain; and platform statistics. Two more cost ten cents in USDC per call — the written market brief and full candle history — because one runs a model and the other pulls a heavy upstream series. Every response says how long it stays valid, so a polling client knows when it is worth asking again. The developer page runs every example live, and there is an OpenAPI document and an llms.txt index for machines.",
  },
  {
    q: "Why do two API endpoints cost money, and how do I pay?",
    a: "Through x402, Coinbase's HTTP payment standard: you call the URL, it answers 402 Payment Required with the amount, the asset, the network and the recipient; your client signs a USDC authorization and retries the same URL. There is nothing to sign up for and no key to rotate, which is what lets an agent pay for a call on its own. Settlement only happens after a successful answer, so a request that fails or names an unknown stock never costs anything. The free endpoints stay free because the CDN answers repeats for them; the two paid ones carry a cost per request that no cache can remove.",
  },
  { q: "How do badges work?", a: "Badges mark onchain milestones of your own wallet: first trade, five different stocks, an executed basket, a sent gift, published and popular baskets. Recognition only, there are no payouts." },
  { q: "What happens on a dividend or split?", a: "The issuer updates the token's multiplier onchain and the reference feed may freeze during the action. BStocks shows scheduled multiplier changes ahead of time and keeps showing share-equivalents, so your position reads correctly before and after." },
];

/** A stable anchor per question, so a search hit can land on the one that answers it. */
function faqId(q: string): string {
  return `q-${q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}`;
}

/**
 * The FAQ as schema.org FAQPage, so a search result can show the question and answer directly.
 * Generated from the same array that renders the section; the two cannot disagree.
 */
const FAQ_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
});

/** Everything on this page a reader might search for, indexed from the arrays that render it. */
const SEARCH_ENTRIES: DocEntry[] = [
  ...FEATURES.map((f) => ({ id: "features", title: f.title, body: f.body })),
  ...STEPS.map((st) => ({ id: "steps", title: st.title, body: `${st.body} ${st.detail ?? ""}` })),
  ...FAQ.map((f) => ({ id: faqId(f.q), title: f.q, body: f.a })),
];

export default function HowItWorksPage() {
  return (
    <div className="flex flex-col gap-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: FAQ_JSON_LD }} />
      <section className="hero-fx border border-line rounded-[8px] ticks bg-canvas overflow-hidden">
        <Dither className="fx-layer" pixelSize={5} opacity={0.22} speed={0.25} mouseRadius={120} />
        {/* Readability scrim, same as the home hero: solid canvas under the copy, dots fading in to the right. */}
        <div aria-hidden className="fx-layer pointer-events-none absolute inset-0 bg-gradient-to-r from-canvas from-25% via-canvas/70 via-65% to-transparent" />
        <div className="fx-content p-6 md:p-12">
          <div className="eyebrow mb-3">How it works</div>
          <h1 className="display text-[40px] md:text-[64px] leading-[0.92] max-w-[16ch]">
            Complex infrastructure. <span className="text-primary">Simple product.</span>
          </h1>
          <p className="mt-6 max-w-[52ch] text-ink text-[18px] md:text-[21px] leading-snug font-medium">Find a stock, understand its price, buy it, hold it in your own wallet, build a basket, send it or earn on idle USDC.</p>
          <p className="mt-3 max-w-[60ch] text-ink-secondary text-[14px] md:text-[15px]">Under the hood: B20 tokens, Chainlink reference prices, DEX aggregation, Base Account, Basenames, Builder Codes and Flashblocks. You never have to think about any of it.</p>
          <div className="mt-6 flex gap-2 flex-wrap">
            <LinkButton href="/markets" variant="primary">
              Browse markets
            </LinkButton>
            <LinkButton href="/build">Build a portfolio</LinkButton>
            <LinkButton href="#faq">Questions &amp; answers</LinkButton>
            <LinkButton href="/docs">Technical docs</LinkButton>
            <LinkButton href="/developers">Developer API</LinkButton>
          </div>
        </div>
      </section>

      <section id="features" className="flex flex-col gap-3 scroll-mt-header">
        <div className="eyebrow">What you can do here</div>
        <div className="module-grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 ticks">
          {FEATURES.map(({ icon: Icon, title, body, href }) => (
            <Link key={title} href={href} className="rail p-4 flex flex-col gap-2 hover:bg-surface transition-fast">
              <Icon size={18} strokeWidth={1.75} className="text-primary" />
              <div className="font-medium">{title}</div>
              <p className="text-[13px] text-ink-secondary">{body}</p>
            </Link>
          ))}
        </div>
      </section>

      <div id="steps" className="module-grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 scroll-mt-header">
        {STEPS.map((s) => (
          <article key={s.n} className="p-5 md:p-6 flex flex-col gap-3 min-h-[240px]">
            <div className="display num text-[40px] text-primary leading-none">{s.n}</div>
            <h2 className="display-medium text-[22px]">{s.title}</h2>
            <p className="text-[14px] text-ink">{s.body}</p>
            <p className="text-[13px] text-ink-secondary mt-auto">{s.detail}</p>
          </article>
        ))}
      </div>

      <IntegrationsSection />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="border border-line rounded-[8px] bg-canvas p-5 flex flex-col gap-3">
          <div className="eyebrow">Safety model</div>
          <ul className="text-[14px] flex flex-col gap-2 list-disc pl-5">
            <li>Self-custodial: BStocks never holds keys or funds and never asks for a signature on page load.</li>
            <li>Only verified assets from the canonical registry are tradable; new tokens must come from Coinbase&apos;s deployer and carry a Chainlink feed.</li>
            <li>Quotes come from execution providers through the server; API secrets stay server-side.</li>
            <li>Simulation before every send; failures are explained, nothing is sent.</li>
            <li>Partial basket fills are shown honestly, never rolled back to “nothing happened”.</li>
          </ul>
        </div>
        <div className="border border-line rounded-[8px] bg-canvas p-5 flex flex-col gap-3">
          <div className="eyebrow">Fees and status</div>
          <ul className="text-[14px] flex flex-col gap-2 list-disc pl-5">
            <li>You pay the network fee on Base (typically cents) and any DEX fee inside the quoted price. BStocks shows the estimated fee before you confirm.</li>
            <li>Status runs Submitted → Preconfirmed → Confirmed using Base&apos;s fast confirmation infrastructure, with normal receipt tracking as fallback.</li>
            <li>Base Account users can batch approval and trade into one confirmation; gas may be sponsored when a paymaster is configured.</li>
          </ul>
          <Link href="/settings" className="text-primary text-[13px] font-medium mt-auto">
            Trading settings →
          </Link>
        </div>
      </section>

      <section id="faq" className="flex flex-col gap-3 scroll-mt-header">
        <div className="eyebrow">Questions &amp; answers</div>
        <DocSearch entries={SEARCH_ENTRIES} placeholder="Search this page: fees, gas, eligibility, gifts…" />
        <div className="border border-line rounded-[8px] bg-canvas divide-y divide-line">
          {FAQ.map((f) => (
            <details key={f.q} id={faqId(f.q)} className="group px-4 md:px-5 scroll-mt-header">
              <summary className="cursor-pointer select-none py-3.5 text-[15px] font-medium list-none flex items-center justify-between gap-3">
                {f.q}
                <span aria-hidden className="font-mono text-ink-muted group-open:rotate-45 transition-transform">+</span>
              </summary>
              <p className="pb-4 text-[14px] text-ink-secondary leading-relaxed max-w-[80ch]">{f.a}</p>
            </details>
          ))}
        </div>
        <p className="text-[12px] text-ink-muted">
          Technical details (contracts, data sources, providers, environment) live in the repository docs. Service health is on the{" "}
          <Link href="/status" className="text-primary font-medium">
            Status page
          </Link>
          .
        </p>
      </section>

      <LegalNotice />
    </div>
  );
}

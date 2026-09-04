import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, Blocks, Bot, Boxes, Gift, Landmark, LineChart, Newspaper, PieChart, Repeat, ShieldCheck, Sprout, Users } from "lucide-react";
import { LinkButton } from "@/components/ui/primitives";
import { LegalNotice } from "@/components/common/display";
import { Dither } from "@/components/fx/Dither";
import { IntegrationsSection } from "@/components/common/Integrations";

export const metadata: Metadata = { title: "How it works" };

const FEATURES = [
  { icon: LineChart, title: "Markets", body: "13 Coinbase Tokenized Stocks with live DEX price, Chainlink reference, candles, volume, liquidity and a Live / Thin / Very thin / No pool / Not issued status.", href: "/markets" },
  { icon: BarChart3, title: "Trade", body: "Every quote asks KyberSwap, Velora, Uniswap, Aerodrome and, when enabled, 0x and OKX at once; you pick auto (best net) or a provider, including gasless CoW signed orders (0x joins outside the US, where its API serves). Limit orders at your own price. Pay with USDC or ETH.", href: "/markets" },
  { icon: Blocks, title: "Build", body: "Baskets from sliders or templates, previewed with live quotes, executed leg by leg. Not-issued names stay as USDC or spread across live ones.", href: "/build" },
  { icon: Repeat, title: "Automate", body: "Recurring buys and basket plans, guided or drafted from a sentence; every run waits for your wallet confirmation.", href: "/automate" },
  { icon: Sprout, title: "Earn", body: "Idle USDC into Morpho vaults, Aave V3 and Compound v3 from here. Stock venues, pools and your LP positions are discovered, not hardcoded.", href: "/earn" },
  { icon: Gift, title: "Send & gift", body: "To a Basename or address, or a claim link (single or a batch) for someone without a wallet: the stock waits in an ownerless escrow until they claim it with a passkey.", href: "/gifts" },
  { icon: Boxes, title: "Gift pools", body: "One deposit, many equal shares. Ten people take 10% each, a package of several stocks pays out in one claim, and whatever nobody claims comes back to you. Optional steps first: a Basename, a purchase, a follow on X.", href: "/pools" },
  { icon: PieChart, title: "Portfolio", body: "Value, allocation, history, LP positions, activity with onchain verification, rebalance against a template, daily AI summary.", href: "/portfolio" },
  { icon: Users, title: "Community", body: "Published baskets, votes, clones, public pages under your Basename, badges. Templates, not recommendations.", href: "/community" },
  { icon: Newspaper, title: "News & brief", body: "Headlines from several publishers per stock and market-wide, plus one shared AI brief refreshed every six hours.", href: "/news" },
  { icon: Bot, title: "Assistant, fenced", body: "Drafts baskets and plans from live tickers and market context, summarises news and your day. It cannot sign, approve or pick addresses.", href: "/build" },
  { icon: Landmark, title: "Compliance", body: "Eligibility notice for restricted regions, issuer policies and pauses read before every action, plain-language errors.", href: "/how-it-works#faq" },
  { icon: ShieldCheck, title: "Status", body: "Live checks of the chain, price feeds, trading routes, yield venues, news and storage this app depends on.", href: "/status" },
];

const STEPS = [
  { n: "01", title: "Find", body: "Thirteen Coinbase Tokenized Stocks live on Base as B20 tokens. BStocks identifies each one by its contract address, never by ticker, because names and symbols can change onchain.", detail: "Assets are read straight from the chain: name, decimals, multiplier, transfer policy, pause flags, supply. New B20 tokens from Coinbase's deployer are discovered automatically." },
  { n: "02", title: "Understand", body: "Three prices, kept separate on purpose. Market is the DEX price. Reference is the Chainlink total-return feed with an explicit freshness flag. Executable is the live quote you actually trade at.", detail: "One token is not always one share: dividends and splits adjust a multiplier. BStocks shows share-equivalents, not raw token counts." },
  { n: "03", title: "Buy or sell", body: "Pick an amount, compare providers, review a firm quote (price, impact, network fee), confirm in your wallet. Quotes are fetched server-side; keys never touch your browser.", detail: "Approvals are scoped to the exact amount and granted only to the spender the provider returns. Every transaction is simulated before it is sent." },
  { n: "04", title: "Hold", body: "Tokens sit in your wallet, not with BStocks. Issuer policies and pauses are read before every action and explained in plain language if they block a transfer.", detail: "Corporate actions (dividends, splits) show up as multiplier changes and reference-price freezes, never as invented cash events." },
  { n: "05", title: "Build & automate", body: "Compose a basket with sliders, a template or a guided AI draft. Each leg is a separate trade you confirm; if one fails, the completed ones stay and you can retry the rest.", detail: "Plans repeat a buy or a basket on a schedule; a due run is a proposal until you confirm it." },
  { n: "06", title: "Send or earn", body: "Send stock to a Basename like alice.base.eth or a 0x address; the resolved address is always shown before you confirm. Earn venues are discovered at runtime and hidden when none exist.", detail: "USDC deposits into Morpho, Aave V3 and Compound v3 run in-app; USDC pools open right here from a USD price range, and positions, fees, collect and withdraw live here too." },
];

const FAQ: Array<{ q: string; a: string }> = [
  { q: "What is a Coinbase Tokenized Stock?", a: "An ERC-20 token on Base issued by Coinbase under the B20 standard, backed one-to-one by the underlying share held by the issuer. Dividends and splits are reflected through an onchain multiplier, so one token can equal more or less than one share over time." },
  { q: "Why does a stock say “not issued yet”?", a: "The contract exists on Base but Coinbase has not minted any tokens, so there is no supply, no pool and no route that can fill an order. It becomes tradable automatically the moment supply appears; add it to your watchlist meanwhile." },
  { q: "Who can trade here?", a: "Coinbase Tokenized Stocks are offered to eligible persons outside the United States. Visitors from restricted regions see an eligibility notice and must confirm they are eligible before trading; browsing prices, charts and news stays open to everyone." },
  { q: "Where do prices come from?", a: "Market price and liquidity come from the primary DEX pool (DexScreener, GeckoTerminal). The reference price is the Chainlink total-return feed for the stock, shown with a freshness flag (live, last close, stale, frozen). The executable price is the live quote from the provider you trade with." },
  { q: "Who executes my trade?", a: "Every quote is requested from several routes at once: KyberSwap, Velora, the Uniswap Trading API, Aerodrome directly, and 0x or OKX when they are enabled. BStocks shows every answer, picks the best net output by default, and lets you choose a provider. The swap itself is a transaction your wallet signs." },
  { q: "Do I need ETH on Base to use this?", a: "Often not. With a Base Account (passkey wallet), gas is sponsored by a paymaster where its policy allows \u2014 trades, earn deposits, liquidity actions and gift claims can all run with zero ETH; a declined sponsorship just means your wallet asks you to pay instead. Classic wallets pay the Base network fee themselves, usually under a cent. CoW limit orders need no gas to place or cancel, and gift claims can even be paid by someone else entirely." },
  { q: "What fees do I pay?", a: "The Base network fee (usually cents), any DEX fee inside the quoted price, and any provider fee shown in the quote. BStocks charges nothing itself. Base Account users may get sponsored gas when a paymaster is configured." },
  { q: "Is BStocks custodial?", a: "No. Tokens stay in your wallet, approvals are limited to the exact amount and spender, and nothing is signed on page load. BStocks stores records (trades, gifts, plans, profiles) offchain to explain what happened, never keys or funds." },
  { q: "Can I pay with ETH?", a: "Yes. Choose “Pay with ETH” in the trade panel and the route swaps ETH already on Base; no bridge is needed. USDC remains the default settlement asset." },
  { q: "How do I get USDC on Base?", a: "Withdraw USDC on the Base network from Coinbase or another exchange to the address shown under Add funds, use your wallet's card or bank onramp, or bridge or swap from another chain with LI.FI. Base Account can also draw from a Coinbase balance at confirmation." },
  { q: "What does the assistant do, and what can it not do?", a: "It drafts baskets and plans from the listed tickers and live market context, writes a shared market brief and, on request, a daily summary of your portfolio. It cannot sign, approve, pick contract addresses or execute anything, it only knows the listed stocks, and every output is re-validated on the server. It is not advice." },
  { q: "What data does the assistant see?", a: "For drafts: ticker, name, tags, live or not, price, 24h move and DEX liquidity. For the market brief: headlines (titles only) and prices. For your daily summary: your onchain balances, last-24h activity and headlines about held stocks, sent only when you ask." },
  { q: "Can I add liquidity from here?", a: "Yes, for USDC pools on Uniswap v3 and Aerodrome Slipstream: open a pool from a stock's Earn tab, pick a price range in USD per share, and both deposit amounts are derived for you — simulated before your wallet opens, exact approvals only. Collecting fees and withdrawing also run in-app; other pool types still open on the venue while positions stay tracked here." },
  { q: "How do limit orders work?", a: "A limit order is an EIP-712 message you sign, not a transaction: it waits in the CoW Protocol order book until a solver can fill it at your price or better (partial fills allowed), for up to three hours. The solver pays the gas; fees come out of the difference to the market price. Cancel any time from Your orders — free for regular wallets, a small transaction for smart accounts." },
  { q: "What is a claim-link gift?", a: "A way to gift stock to someone without a wallet. The stock moves into an ownerless escrow contract; the link you share carries the claim key in its fragment, which never reaches any server. Whoever opens the link creates a passkey wallet (or connects one) and claims — gas sponsored where the paymaster allows. You can cancel unclaimed links any time, and they expire on their own." },
  { q: "What is a gift pool?", a: "One deposit that many people can claim an equal share of. You say how much goes in and how many people it is for; the contract holds it and pays each claimer exactly one share, one per wallet. A pool can hold several stocks at once, so a claim delivers a small package rather than a single name. Share it as a link, list it publicly, or put steps in front of it. Nothing rounds: the share is fixed when you create the pool, so there is never a last person who gets less." },
  { q: "Can I get a gift pool back?", a: "Yes. Closing a pool stops new claims immediately and returns everything unclaimed to your wallet; shares already taken stay with the people who took them. You can also lock a pool for a few days when you create it — then even you cannot close it until that date, which anyone can verify onchain and which is exactly what makes a public giveaway trustworthy." },
  { q: "Do the tasks on a pool actually get checked?", a: "Some of them, and the app always tells you which. Owning a Basename, holding a stock and having bought one are read from Base — a purchase is re-read from its transaction receipt, so it cannot be faked. The rest are different: a follow, a repost, a like or a visit to a page cannot be checked by anyone from outside, so they are recorded as the claimant's own confirmation, with their wallet and a timestamp, and shown as “declared” rather than verified on the creator's list. A pool can ask for up to eight steps and repeat them — several accounts to follow, several links to read — but pair at least one with an onchain step if a campaign has to hold up." },
  { q: "How do badges work?", a: "Badges mark onchain milestones of your own wallet: first trade, five different stocks, an executed basket, a sent gift, published and popular baskets. Recognition only, there are no payouts." },
  { q: "What happens on a dividend or split?", a: "The issuer updates the token's multiplier onchain and the reference feed may freeze during the action. BStocks shows scheduled multiplier changes ahead of time and keeps showing share-equivalents, so your position reads correctly before and after." },
];

export default function HowItWorksPage() {
  return (
    <div className="flex flex-col gap-8">
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
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
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

      <div className="module-grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
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

      <section id="faq" className="flex flex-col gap-3 scroll-mt-24">
        <div className="eyebrow">Questions &amp; answers</div>
        <div className="border border-line rounded-[8px] bg-canvas divide-y divide-line">
          {FAQ.map((f) => (
            <details key={f.q} className="group px-4 md:px-5">
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

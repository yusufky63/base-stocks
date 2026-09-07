import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Blocks, Boxes, Coins, Database, EyeOff, GitBranch, KeyRound, Network, Send, ShieldCheck, Smartphone, Timer, Wallet, Zap } from "lucide-react";
import { PRO_PRICE_USD, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import {
  B20_FACTORY_ADDRESS,
  B20_ACTIVATION_REGISTRY_ADDRESS,
  B20_POLICY_REGISTRY_ADDRESS,
  BASE_EXPLORER_URL,
  BASENAMES_L2_RESOLVER_ADDRESS,
  COINBASE_B20_CREATORS,
  MULTICALL3_ADDRESS,
  STOCK_ORACLE_REGISTRY_ADDRESS,
  USDC_ADDRESS,
} from "@/config/chain";
import { GIFT_ESCROW_ADDRESS } from "@/lib/escrow/index";
import { GPV2_SETTLEMENT, GPV2_VAULT_RELAYER } from "@/providers/trading/cow/adapter";
import { LP_MANAGER_INFO } from "@/lib/earn/lp-managers";
import { IntegrationMark } from "@/components/common/IntegrationMark";
import { LinkButton } from "@/components/ui/primitives";
import { Dither } from "@/components/fx/lazy";

export const metadata: Metadata = {
  title: "Technical docs",
  description: "How BaseStocks works under the hood: the B20 token standard, price model, trade routing, CoW limit orders, concentrated liquidity, the gift escrow, the Copilot assistant, the public read-only API and the contract addresses it talks to.",
};

/* ------------------------------------------------------------------ data */

const NAV = [
  ["architecture", "Architecture"],
  ["b20", "B20 standard"],
  ["prices", "Price model"],
  ["trading", "Trading"],
  ["limit-orders", "Limit orders"],
  ["earn", "Liquidity math"],
  ["gifts", "Gift escrow"],
  ["gas", "Gas & sponsorship"],
  ["copilot", "Copilot"],
  ["api", "Public API"],
  ["privacy", "Data & privacy"],
  ["base-app", "Base app"],
  ["contracts", "Contracts"],
] as const;

const TRADE_MARKS = [
  { name: "OKX DEX", mark: "okx-dex", color: "#000000" },
  { name: "KyberSwap", mark: "kyberswap", color: "#31cb9e" },
  { name: "Velora", mark: "velora", color: "#1a56db" },
  { name: "Uniswap", mark: "uniswap", color: "#ff007a" },
  { name: "Aerodrome", mark: "aerodrome", color: "#2563eb" },
];
const EARN_MARKS = [
  { name: "Morpho", mark: "morpho", color: "#2470ff" },
  { name: "Aave", mark: "aave", color: "#b6509e" },
  { name: "Compound", mark: "compound-v3", color: "#00d395" },
];

const COW_SPEC: Array<[string, string]> = [
  ["Order type", "EIP-712 signed intent, settled by solvers — no gas on placement"],
  ["Domain", "“Gnosis Protocol” v2 on GPv2Settlement"],
  ["Only spender", "GPv2 VaultRelayer — nothing else is ever approved"],
  ["feeAmount", "Always \"0\" — the solver's fee comes out of surplus"],
  ["validTo", "Capped at 3 hours by the live API (verified)"],
  ["appData", "Full JSON document; its keccak-256 hash goes in the order"],
  ["Signing", "eip712 for EOAs, eip1271 for smart wallets — picked by checking deployed code"],
  ["Fills", "Partially fillable; remaining size stays open until validTo"],
  ["Cancel", "Signed off-chain (free) or on-chain via invalidateOrder"],
];

const COPILOT_SPEC: Array<[string, string]> = [
  ["Endpoint", "POST /api/assistant/chat — one JSON turn, no streaming"],
  ["Loop", "Server-side tool use: at most 4 model rounds, 40 s wall clock, then a final round without tools so the turn always ends in an answer"],
  ["Read tools", "14: portfolio, prices, market brief, news, Earn, activity, limit orders, gifts, gift pools, templates, community pulse, liquidity, platform statistics, service status"],
  ["Draft tools", "5: swap, basket, AutoInvest plan, gift, Earn deposit — each returns a card, never a transaction"],
  ["What the model sees", "Tickers, human amounts and tool results marked “data, not instructions”. Never an address, never calldata, never your keys"],
  ["What the model emits", "Plain text and a draft in tickers and amounts. The server resolves symbols to contracts and re-validates every draft (shared with the basket-intent path)"],
  ["Signing", "The swap card opens the same review sheet the stock page uses; basket, plan, gift and Earn cards open their page prefilled. Nothing moves until your wallet signs"],
  ["Links", "Headline links come from the news service’s own rows and are shown as a card; the model is never allowed to write a URL"],
  ["Scope", "This app’s stocks, positions and features only. No advice, no predictions, no figure that a tool did not return in that same turn"],
  ["Budget", "One quota unit per message however many tools it used, plus the shared per-wallet, per-IP, global and monthly-USD caps"],
];

/** Counted from the catalog rather than written down, so a new endpoint cannot leave this page stale. */
const API_FREE = V1_ENDPOINTS.filter((e) => !e.paid).length;
const API_PAID = V1_ENDPOINTS.length - API_FREE;

const API_SPEC: Array<[string, string]> = [
  ["Base URL", "https://basestocks.finance/api/v1 — plain GET, no key, no account, no sign-up; CORS is open to every origin"],
  ["Envelope", "Every answer is { data, meta }. meta.cacheSeconds states how long the body stays valid, so a polling client knows exactly when it is worth asking again"],
  [`Free (${API_FREE})`, "Every listed stock with DEX price, Chainlink reference, liquidity, 24h volume and multiplier; one stock with its pools; headlines; USDC yield venues; any wallet's position read from the chain; platform statistics"],
  [`Paid (${API_PAID})`, `The written market brief and full candle history — ${PRO_PRICE_USD} in USDC per call over x402. One runs a model, the other pulls a heavy upstream series: costs a cache cannot remove`],
  ["Paying", "Call the URL, get 402 with the amount, asset, network and recipient, sign a USDC authorization, retry the same URL. Settlement happens only after a successful answer, so a failed or unknown-symbol request is never charged"],
  ["Caching", "Each route declares its own s-maxage and the CDN honours it. A thousand readers cost this app what one does, which is why the free tier can stay free"],
  ["Machine-readable", "/api/v1/openapi.json is OpenAPI 3.1; /llms.txt is the one-fetch index an assistant reads before it calls anything"],
  ["Read-only, by construction", "No endpoint signs, sends, executes or holds a key. The four B20 traps — multiplier, total-return reference, 24/5 feeds, address-as-identity — are returned explicitly rather than left to be inferred"],
];

const GAS_SPEC: Array<[string, string]> = [
  ["Base Account", "Transactions go out as EIP-5792 batches; the CDP paymaster sponsors gas where its policy allows, so a fresh passkey wallet can act with zero ETH"],
  ["Other wallets", "You pay the Base network fee yourself \u2014 usually well under a cent per transaction"],
  ["Trades & earn & LP", "Same rule: sponsored on Base Account when the paymaster accepts, otherwise cents of ETH; approval + action is one confirmation on Base Account, two elsewhere"],
  ["CoW limit orders", "Placing and (off-chain) cancelling cost no gas at all \u2014 the winning solver pays the settlement gas; only the one-time approval is a transaction"],
  ["Gift claims", "claim() is allowlisted on the paymaster, so recipients with empty wallets claim for free; the function is also permissionless \u2014 anyone holding the recipient's EIP-712 signature can pay the gas instead"],
  ["Sponsorship limits", "Paymaster budgets and policies live on Coinbase Developer Platform; if a sponsorship is declined the wallet simply asks the user to pay, nothing breaks"],
];

const GIFT_SPEC: Array<[string, string]> = [
  ["Contract", "Ownerless — no admin, no upgrade path, verified source"],
  ["Claim link secret", "Lives only in the URL fragment; never reaches any server"],
  ["Stored onchain", "keccak256(claim key) — the secret itself is never onchain either"],
  ["Claim auth", "EIP-712 Claim(giftId, recipient) signature from the secret key"],
  ["Who pays claim gas", "Anyone — claims are permissionless, so a sponsor can cover brand-new wallets"],
  ["Reclaim", "The sender, at any time before claim"],
  ["Expiry", "Chosen per gift, at most 90 days"],
  ["Reentrancy", "Checks-effects-interactions plus a mutex guard"],
];

const CONTRACTS: Array<{ label: string; address: string; note: string }> = [
  { label: "B20 factory", address: B20_FACTORY_ADDRESS, note: "Deploys Coinbase Tokenized Stock (B20) tokens" },
  { label: "Activation registry", address: B20_ACTIVATION_REGISTRY_ADDRESS, note: "B20 activation state" },
  { label: "Policy registry", address: B20_POLICY_REGISTRY_ADDRESS, note: "Transfer policies; approve() is not policy-gated" },
  { label: "Stock OracleRegistry", address: STOCK_ORACLE_REGISTRY_ADDRESS, note: "getOracleParams(token) → (multiplier, paused)" },
  { label: "Coinbase B20 creator", address: COINBASE_B20_CREATORS[0]!, note: "Only tokens created by this EOA are trusted in discovery" },
  { label: "USDC", address: USDC_ADDRESS, note: "Quote and settlement currency, 6 decimals" },
  { label: "BaseStocks GiftEscrow", address: GIFT_ESCROW_ADDRESS, note: "Ownerless, verified; holds gifts until claim or reclaim" },
  { label: "CoW GPv2Settlement", address: GPV2_SETTLEMENT, note: "EIP-712 domain “Gnosis Protocol” v2; settles limit orders" },
  { label: "CoW VaultRelayer", address: GPV2_VAULT_RELAYER, note: "The only spender approved for CoW orders" },
  ...LP_MANAGER_INFO.map((m) => ({ label: `${m.label} position manager`, address: m.npm, note: `Mint / collect / withdraw; factory ${m.factory.slice(0, 10)}…` })),
  { label: "Basenames L2 resolver", address: BASENAMES_L2_RESOLVER_ADDRESS, note: "Reverse-resolves wallet → name for profiles" },
  { label: "Multicall3", address: MULTICALL3_ADDRESS, note: "Batched reads everywhere" },
];

/* ------------------------------------------------------------------ atoms */

function SectionHead({ n, id, title, sub }: { n: number; id: string; title: string; sub?: string }) {
  return (
    <div id={id} className="scroll-mt-24 flex flex-wrap items-baseline justify-between gap-2">
      <div className="flex items-baseline gap-3">
        <span className="display num text-[28px] md:text-[34px] text-primary leading-none">{String(n).padStart(2, "0")}</span>
        <h2 className="display-medium text-[22px] md:text-[26px]">{title}</h2>
      </div>
      {sub && <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-muted">{sub}</span>}
    </div>
  );
}

function Cell({ icon: Icon, title, children }: { icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <article className="rail p-4 md:p-5 flex flex-col gap-2">
      <Icon size={18} strokeWidth={1.75} className="text-primary" />
      <div className="font-medium">{title}</div>
      <p className="text-[13px] text-ink-secondary leading-relaxed">{children}</p>
    </article>
  );
}

function Formula({ label, lines }: { label: string; lines: string[] }) {
  return (
    <article className="rail p-4 md:p-5 flex flex-col justify-center gap-2 bg-surface-muted/40">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      {lines.map((l) => (
        <div key={l} className="font-mono num text-[13px] lg:text-[15px] text-ink">
          {l}
        </div>
      ))}
    </article>
  );
}

function SpecRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="border border-line rounded-[8px] bg-canvas overflow-hidden">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-x-4 px-4 py-2.5 border-b border-line last:border-b-0">
          <div className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-muted pt-0.5">{k}</div>
          <div className="text-[13px] text-ink">{v}</div>
        </div>
      ))}
    </div>
  );
}

function Marks({ items }: { items: Array<{ name: string; mark: string | null; color: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {items.map((i) => (
        <span key={i.name} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-secondary">
          <IntegrationMark name={i.name} mark={i.mark} color={i.color} size={18} /> {i.name}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function DocsPage() {
  return (
    <div className="flex flex-col gap-10">
      <section className="hero-fx border border-line rounded-[8px] ticks bg-canvas overflow-hidden">
        <Dither className="fx-layer" pixelSize={5} opacity={0.22} speed={0.25} mouseRadius={120} />
        <div aria-hidden className="fx-layer pointer-events-none absolute inset-0 bg-gradient-to-r from-canvas from-25% via-canvas/70 via-65% to-transparent" />
        <div className="fx-content p-6 md:p-12">
          <div className="eyebrow mb-3">Technical documentation</div>
          <h1 className="display text-[38px] md:text-[60px] leading-[0.94] max-w-[16ch]">
            Under the hood, <span className="text-primary">verified onchain</span>.
          </h1>
          <p className="mt-5 max-w-[56ch] text-ink-secondary text-[14px] md:text-[16px]">
            Standards, math, order flow and the exact contracts this app is built against. For the plain-language version, read{" "}
            <Link href="/how-it-works" className="text-primary font-medium">
              How it works
            </Link>
            .
          </p>
          <nav className="mt-6 flex flex-wrap gap-1.5">
            <Link href="/docs/reference" className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-primary bg-primary-soft text-[12px] font-medium text-primary hover:bg-primary hover:text-primary-contrast transition-fast">
              Full reference <ArrowUpRight size={12} strokeWidth={2} />
            </Link>
            {NAV.map(([id, title], i) => (
              <a key={id} href={`#${id}`} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-line bg-canvas/70 text-[12px] font-medium text-ink-secondary hover:border-primary hover:text-primary transition-fast">
                <span className="font-mono num text-[10px] text-ink-muted">{String(i + 1).padStart(2, "0")}</span> {title}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={1} id="architecture" title="Architecture" sub="client-first · non-custodial" />
        <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
          <Cell icon={KeyRound} title="Your keys sign everything">
            The server aggregates public data and stores the social layer; it never holds keys and never signs. Every transaction is built in the browser, simulated, and signed by your own wallet. BaseStocks never custodies funds.
          </Cell>
          <Cell icon={Network} title="Reads that survive outages">
            All reads batch through Multicall3 and rotate across the keyed RPCs by weight — no single account carries the traffic — with every other provider, then four public endpoints, queued behind whichever one served the call. Log sweeps skip providers that cap block ranges. Confirmations arrive in ~200 ms — Flashblocks preconfirmations today, canonical 200 ms blocks once the Denim hardfork activates; the same receipt call covers both.
          </Cell>
          <Cell icon={Zap} title="One signature, many calls">
            On Base Account, approve + swap or approve + mint go out as a single atomic EIP-5792 batch, gas-sponsored when the paymaster allows, with ERC-8021 builder attribution on every call.
          </Cell>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={2} id="b20" title="The B20 token standard" sub="Coinbase Tokenized Stocks" />
        <div className="module-grid grid-cols-1 md:grid-cols-[1.1fr_1fr_1fr] ticks">
          <Formula label="Share equivalents" lines={["scaled = raw × mult / 1e18", "8 decimals · WAD multiplier"]} />
          <Cell icon={Blocks} title="Corporate actions, onchain">
            Splits and dividends update the token&apos;s multiplier; scheduled changes are announced onchain ahead of time and shown on the stock page. The OracleRegistry&apos;s pause flag freezes the reference feed during the action — surfaced, never hidden.
          </Cell>
          <Cell icon={ShieldCheck} title="Discovery trusts one creator">
            Dozens of copycat “NVDAc” tokens exist. Discovery only accepts B20s deployed by Coinbase&apos;s creator address and picks up new listings with a background scan roughly every 30 minutes.
          </Cell>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={3} id="prices" title="Price model" sub="two prices, both shown" />
        <div className="module-grid grid-cols-1 md:grid-cols-2 ticks">
          <article className="rail p-4 md:p-5 flex flex-col gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Display price · live market</div>
            <div className="flex items-center gap-2 text-[14px] font-medium">
              DexScreener <span className="text-ink-muted">→</span> GeckoTerminal
            </div>
            <p className="text-[13px] text-ink-secondary leading-relaxed">What the pools are actually paying right now; the second source takes over when the first is down.</p>
          </article>
          <article className="rail p-4 md:p-5 flex flex-col gap-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Reference price · Chainlink</div>
            <div className="flex items-center gap-2 text-[14px] font-medium">
              8 decimals · total-return · 24/5
            </div>
            <p className="text-[13px] text-ink-secondary leading-relaxed">Marked stale after one hour without an update. Price-impact math prefers a fresh reference as its fair-value basis.</p>
          </article>
        </div>
        <Formula label="Per-share figures" lines={["per share = token price ÷ multiplier"]} />
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={4} id="trading" title="Trading and routing" sub="best net output wins" />
        <div className="border border-line rounded-[8px] bg-canvas px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <Marks items={TRADE_MARKS} />
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">quoted in parallel</span>
        </div>
        <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
          <Cell icon={GitBranch} title="Net wins, failures listed">
            Every provider quotes at once; the route with the best net output (output minus estimated network fee) wins. Providers that fail are listed with their reasons instead of silently dropped.
          </Cell>
          <Cell icon={Timer} title="Firm quote before signing">
            The review sheet re-fetches a binding quote right before you sign, so the numbers you approve are the numbers that execute.
          </Cell>
          <Cell icon={ShieldCheck} title="Simulated, exact approvals">
            The whole bundle runs through an eth_simulateV1 check before the wallet opens. Approvals are exact-amount to the specific router in use — never unlimited, never to an address from the quote payload.
          </Cell>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={5} id="limit-orders" title="Limit orders on CoW Protocol" sub="facts verified against the live API" />
        <SpecRows rows={COW_SPEC} />
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={6} id="earn" title="Earn and liquidity math" sub="in-app, simulated first" />
        <div className="module-grid grid-cols-1 md:grid-cols-[1.1fr_1fr_1fr] ticks">
          <Formula label="Concentrated liquidity" lines={["price(tick) = 1.0001^tick", "USD per share ⇄ tick, spacing-aligned"]} />
          <article className="rail p-4 md:p-5 flex flex-col gap-2">
            <Coins size={18} strokeWidth={1.75} className="text-primary" />
            <div className="font-medium">USDC yield venues</div>
            <Marks items={EARN_MARKS} />
            <p className="text-[13px] text-ink-secondary leading-relaxed">Deposits and withdrawals run in-app: exact approval to the venue, simulated, signed by your wallet.</p>
          </article>
          <Cell icon={Boxes} title="LP positions, end to end">
            Mint from a USD-per-share range (one token amount derives the other from the current √price), collect fees — singly or all at once — and withdraw 25–100%. Minimums sit 1% under the shown amounts; deadlines are 10 minutes.
          </Cell>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={7} id="gifts" title="Gift escrow" sub={`${GIFT_ESCROW_ADDRESS.slice(0, 10)}…`} />
        <SpecRows rows={GIFT_SPEC} />
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={8} id="gas" title="Gas and sponsorship" sub="who pays for what" />
        <SpecRows rows={GAS_SPEC} />
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={9} id="copilot" title="Copilot" sub="drafts, never executes" />
        <SpecRows rows={COPILOT_SPEC} />
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={10} id="api" title="Public API" sub="read-only · no key" />
        <SpecRows rows={API_SPEC} />
        <p className="text-[13px] text-ink-secondary leading-relaxed">
          Everything this app shows about tokenized stocks is available as an API, on the same data and the same caches the pages use — so what a caller reads
          cannot drift from what a visitor sees.{" "}
          <Link href="/developers" className="text-primary font-medium">
            The developer page
          </Link>{" "}
          runs every example live against this deployment.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={11} id="privacy" title="Data, limits and privacy" />
        <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
          <Cell icon={Database} title="Supabase for the social layer">
            Baskets, profiles, gift metadata and AI usage live behind row-level security. Positions and balances are always read from the chain, never mirrored.
          </Cell>
          <Cell icon={Timer} title="Durable rate limits">
            API routes limit per hashed IP in fixed windows that survive serverless cold starts. AI features run on small models with per-wallet quotas surfaced before they run out.
          </Cell>
          <Cell icon={EyeOff} title="Nothing to leak">
            No analytics wallets, no custodial keys, no secrets in the client bundle. The only privileged surface is an admin API behind a server-side token.
          </Cell>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={12} id="base-app" title="Inside the Base app" sub="the same app, one frame in" />
        <div className="module-grid grid-cols-1 md:grid-cols-3 ticks">
          <Cell icon={Smartphone} title="A mini app, not a wrapper">
            The site is served as a Base mini app from <span className="font-mono text-[12px]">/.well-known/farcaster.json</span>. There is no second build and no
            second codebase: the host opens the same pages, and the app tells it when it has finished loading so the splash screen comes down.
          </Cell>
          <Cell icon={Wallet} title="The host wallet, no modal">
            Inside the app the wallet is the one already signed in there, already on Base, and it is connected on arrival. Nothing is signed on load
            here either — connecting is not signing, and every trade, claim and approval is still confirmed by you.
          </Cell>
          <Cell icon={Send} title="Links that launch the page">
            A shared gift pool carries its own launch card, so the button opens that pool rather than the home page. Link-gated pools keep their key in
            the URL fragment, which never reaches a server, so those are deliberately left without one.
          </Cell>
        </div>
        <p className="text-[13px] text-ink-secondary leading-relaxed">
          A mini app host embeds the page in a frame, so the site allows framing from the Base and Farcaster hosts by name and refuses everyone else —
          <span className="font-mono text-[12px]"> frame-ancestors</span> rather than a blanket denial, which would have shown a blank panel instead of the app.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHead n={13} id="contracts" title="Contract addresses" sub="Base mainnet" />
        <div className="border border-line rounded-[8px] bg-canvas overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-surface-muted/40">
                <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted font-medium">Contract</th>
                <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted font-medium">Address · role</th>
              </tr>
            </thead>
            <tbody>
              {CONTRACTS.map((c) => (
                <tr key={c.address + c.label} className="border-b border-line last:border-b-0 hover:bg-surface transition-fast">
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap align-top">{c.label}</td>
                  <td className="px-4 py-2.5 align-top">
                    <a href={`${BASE_EXPLORER_URL}/address/${c.address}`} target="_blank" rel="noreferrer noopener" className="group inline-flex items-center gap-1 font-mono text-[12px] text-primary break-all">
                      {c.address}
                      <ArrowUpRight size={12} strokeWidth={1.75} className="opacity-0 group-hover:opacity-100 transition-fast shrink-0" />
                    </a>
                    <span className="block text-[12px] text-ink-muted">{c.note}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-ink-muted max-w-[70ch]">B20 stock tokens themselves all start with 0xb2… and are listed with their address on each stock page. Always verify on Basescan before interacting with a contract directly.</p>
      </section>

      <section className="border border-line rounded-[8px] ticks bg-canvas p-5 md:p-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ink-secondary max-w-[52ch]">Prefer the simple version? The user guide covers the same ground without the internals.</p>
        <LinkButton href="/how-it-works" variant="primary">
          Read How it works
        </LinkButton>
      </section>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
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
import { LinkButton } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Technical docs",
  description: "How BStocks works under the hood: the B20 token standard, price model, trade routing, CoW limit orders, concentrated liquidity, the gift escrow and the contract addresses it talks to.",
};

/* ------------------------------------------------------------------ data */

const CONTRACTS: Array<{ label: string; address: string; note: string }> = [
  { label: "B20 factory", address: B20_FACTORY_ADDRESS, note: "Deploys Coinbase Tokenized Stock (B20) tokens" },
  { label: "Activation registry", address: B20_ACTIVATION_REGISTRY_ADDRESS, note: "B20 activation state" },
  { label: "Policy registry", address: B20_POLICY_REGISTRY_ADDRESS, note: "Transfer policies; approve() is not policy-gated" },
  { label: "Stock OracleRegistry", address: STOCK_ORACLE_REGISTRY_ADDRESS, note: "getOracleParams(token) → (multiplier, paused)" },
  { label: "Coinbase B20 creator", address: COINBASE_B20_CREATORS[0]!, note: "Only tokens created by this EOA are trusted in discovery" },
  { label: "USDC", address: USDC_ADDRESS, note: "Quote and settlement currency, 6 decimals" },
  { label: "BStocks GiftEscrow", address: GIFT_ESCROW_ADDRESS, note: "Ownerless, verified on Basescan; holds gifts until claim or reclaim" },
  { label: "CoW GPv2Settlement", address: GPV2_SETTLEMENT, note: "EIP-712 domain “Gnosis Protocol” v2; settles limit orders" },
  { label: "CoW VaultRelayer", address: GPV2_VAULT_RELAYER, note: "The only spender approved for CoW orders" },
  ...LP_MANAGER_INFO.map((m) => ({ label: `${m.label} position manager`, address: m.npm, note: `Mint / collect / withdraw; factory ${m.factory.slice(0, 10)}…` })),
  { label: "Basenames L2 resolver", address: BASENAMES_L2_RESOLVER_ADDRESS, note: "Reverse-resolves wallet → name for profiles" },
  { label: "Multicall3", address: MULTICALL3_ADDRESS, note: "Batched reads everywhere" },
];

const SECTIONS: Array<{ id: string; title: string; paras: string[]; bullets?: string[] }> = [
  {
    id: "architecture",
    title: "Architecture",
    paras: [
      "BStocks is a client-first Next.js app on Base mainnet. The server only aggregates public data (prices, pools, news, discovery) and stores social state; it never holds keys and never signs. Every transaction is built in the browser, simulated, and signed by the user's own wallet — BStocks never custodies funds.",
    ],
    bullets: [
      "Reads batch through Multicall3 and fall back across RPCs: a dedicated RPC first, then Coinbase Developer Platform, then four public endpoints.",
      "Confirmations subscribe to Flashblocks (~200 ms preconfirmations) with mainnet.base.org as backstop.",
      "On Base Account, multi-step actions (approve + swap, approve + mint) go out as one atomic EIP-5792 sendCalls batch, sponsored by a paymaster when available, with ERC-8021 builder attribution appended to calldata.",
    ],
  },
  {
    id: "b20",
    title: "The B20 token standard",
    paras: [
      "Coinbase Tokenized Stocks are B20 tokens: ERC-20 with 8 decimals plus a WAD-scaled multiplier that encodes corporate actions (splits, dividends). Wallet balances are raw units; share-equivalents are scaled = raw × multiplier / 1e18, read via scaledBalanceOf. BStocks always displays share-equivalents.",
      "The OracleRegistry exposes getOracleParams(token) → (multiplier, paused); the pause flag freezes the reference feed during corporate actions and is surfaced in the UI. Scheduled multiplier changes are announced onchain ahead of time and shown on the stock page.",
      "Token discovery only trusts B20s deployed by Coinbase's creator address — dozens of copycat tickers exist from other deployers and are ignored. New listings are picked up by a background scan roughly every 30 minutes.",
    ],
  },
  {
    id: "prices",
    title: "Price model",
    paras: [
      "Two prices exist for every stock and both are shown. The display price is the live market: DexScreener first, GeckoTerminal as fallback. The reference price is the Chainlink feed (8 decimals, total-return, 24/5 market hours) and is marked stale after one hour without an update — shown, never hidden.",
      "Per-share figures divide the token price by the multiplier, so positions read correctly through splits and dividends. Price-impact calculations prefer a fresh Chainlink reference as the fair-value basis.",
    ],
  },
  {
    id: "trading",
    title: "Trading and routing",
    paras: [
      "Market orders are quoted in parallel across OKX DEX (API v6), KyberSwap, Velora, Uniswap and Aerodrome; the route with the best net output (output minus estimated network fee) wins. Failed providers are listed with reasons rather than silently dropped.",
      "The review sheet re-fetches a firm quote before signing, and the whole bundle (approval + swap) is checked with an eth_simulateV1 simulation before the wallet opens. Approvals are exact-amount to the specific router being used, never unlimited.",
    ],
  },
  {
    id: "limit-orders",
    title: "Limit orders on CoW Protocol",
    paras: [
      "Limit orders are EIP-712 orders against GPv2Settlement (domain “Gnosis Protocol” v2). Facts verified against the live API: feeAmount must be \"0\" (fees are taken from surplus), validTo is capped at 3 hours, native ETH cannot be the sell token, and appData is a full JSON document whose keccak-256 hash goes into the order.",
      "Smart wallets sign via ERC-1271 (chosen automatically by checking deployed code); orders are partially fillable; cancellation is off-chain signed or on-chain via invalidateOrder. The only spender ever approved is the CoW VaultRelayer.",
    ],
  },
  {
    id: "earn",
    title: "Earn and concentrated liquidity",
    paras: [
      "USDC deposits route to Morpho vaults, Aave and Compound directly in-app (exact approval, simulated, signed by the wallet). Liquidity provision covers Uniswap v3 and Aerodrome Slipstream.",
      "LP positions are managed fully in-app: mint from a USD-per-share range (the range converts to ticks via price = 1.0001^tick, aligned to the pool's tick spacing; one token amount derives the other from the current sqrt price), collect fees, and withdraw 25–100%. Every bundle simulates first, minimums sit 1% under the shown amounts, deadlines are 10 minutes.",
    ],
  },
  {
    id: "gifts",
    title: "Gift escrow",
    paras: [
      "Gifts lock tokens in an ownerless, verified escrow contract. A gift is addressed either to a wallet or to a claim link: the link carries a secret only in the URL fragment (never sent to any server); the contract stores keccak256(secret) and releases on an EIP-712 Claim signature, so a sponsor can pay the claim gas and brand-new wallets can receive.",
      "Senders can reclaim at any time; unclaimed gifts expire after at most 90 days. The contract follows checks-effects-interactions with a reentrancy guard and has no owner or admin functions.",
    ],
  },
  {
    id: "infra",
    title: "Data, limits and privacy",
    paras: [
      "Supabase stores the social layer (baskets, profiles, gift metadata, AI usage) with row-level security. API routes are rate-limited durably (per-IP hashed windows survive serverless cold starts). AI features run on small models with per-wallet quotas surfaced in the UI before they run out.",
      "No analytics wallets, no custodial keys, no secrets in the client bundle. The only privileged surface is an admin API guarded by a server-side token.",
    ],
  },
];

/* ------------------------------------------------------------------ page */

export default function DocsPage() {
  return (
    <div className="flex flex-col gap-8">
      <section className="border border-line rounded-[8px] ticks bg-canvas p-6 md:p-10">
        <div className="eyebrow mb-3">Technical documentation</div>
        <h1 className="display text-[36px] md:text-[56px] leading-[0.94] max-w-[18ch]">Everything under the hood, verified onchain.</h1>
        <p className="mt-4 max-w-[62ch] text-ink-secondary text-[14px] md:text-[15px]">
          This page is for developers and the curious: standards, math, order flow and the exact contracts BStocks talks to. For the plain-language version, read{" "}
          <Link href="/how-it-works" className="text-primary font-medium">
            How it works
          </Link>
          .
        </p>
        <nav className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-medium">
          {[...SECTIONS.map((s) => ({ id: s.id, title: s.title })), { id: "contracts", title: "Contract addresses" }].map((s) => (
            <a key={s.id} href={`#${s.id}`} className="text-ink-secondary hover:text-primary">
              {s.title}
            </a>
          ))}
        </nav>
      </section>

      {SECTIONS.map((s, i) => (
        <section key={s.id} id={s.id} className="scroll-mt-24 flex flex-col gap-3">
          <div className="eyebrow">
            {String(i + 1).padStart(2, "0")} — {s.title}
          </div>
          <div className="border border-line rounded-[8px] bg-canvas p-5 md:p-6 flex flex-col gap-3 max-w-[840px]">
            {s.paras.map((p) => (
              <p key={p.slice(0, 32)} className="text-[14px] text-ink leading-relaxed">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="list-disc pl-5 text-[13px] text-ink-secondary flex flex-col gap-1.5">
                {s.bullets.map((b) => (
                  <li key={b.slice(0, 32)}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ))}

      <section id="contracts" className="scroll-mt-24 flex flex-col gap-3">
        <div className="eyebrow">{String(SECTIONS.length + 1).padStart(2, "0")} — Contract addresses (Base mainnet)</div>
        <div className="border border-line rounded-[8px] bg-canvas overflow-x-auto">
          <table className="w-full text-[13px]">
            <tbody>
              {CONTRACTS.map((c) => (
                <tr key={c.address + c.label} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2.5 font-medium whitespace-nowrap align-top">{c.label}</td>
                  <td className="px-4 py-2.5 align-top">
                    <a href={`${BASE_EXPLORER_URL}/address/${c.address}`} target="_blank" rel="noreferrer noopener" className="font-mono text-[12px] text-primary break-all">
                      {c.address}
                    </a>
                    <span className="block text-[12px] text-ink-muted">{c.note}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[12px] text-ink-muted max-w-[70ch]">B20 stock tokens themselves all start with 0xb2… and are listed with their addresses on each stock page. Addresses here are the ones this app is built against; always verify on Basescan before interacting directly.</p>
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

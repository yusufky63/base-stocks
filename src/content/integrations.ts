/**
 * Platforms the app is integrated with, grouped by the job they do. This is documentation for
 * people, not configuration: which providers are actually enabled on a deployment depends on its
 * keys (see /api/config and /status). Marks come from DefiLlama's icon CDN where one exists;
 * `mark: null` falls back to a lettered badge.
 */
export interface Integration {
  name: string;
  /** DefiLlama protocol slug for the icon CDN, or null for a lettered badge. */
  mark: string | null;
  color: string;
  url: string;
  role: string;
}

export interface IntegrationGroup {
  id: "trading" | "earn" | "data" | "base" | "funding";
  title: string;
  blurb: string;
  items: Integration[];
}

export const INTEGRATIONS: IntegrationGroup[] = [
  {
    id: "trading",
    title: "Trading",
    blurb: "Every quote asks all configured routes at once; the best net output after network fees wins.",
    items: [
      { name: "KyberSwap", mark: "kyberswap", color: "#31cb9e", url: "https://kyberswap.com", role: "Aggregator, keyless" },
      { name: "Velora", mark: "velora", color: "#1a56db", url: "https://velora.xyz", role: "Aggregator (ParaSwap), keyless" },
      { name: "Uniswap", mark: "uniswap", color: "#ff007a", url: "https://app.uniswap.org", role: "Trading API routes" },
      { name: "Aerodrome", mark: "aerodrome", color: "#2563eb", url: "https://aerodrome.finance", role: "Direct pool swap, deepest stock liquidity" },
      { name: "OKX DEX", mark: "okx-dex", color: "#000000", url: "https://web3.okx.com/dex", role: "Aggregator (Onchain OS)" },
      { name: "0x", mark: "0x", color: "#111111", url: "https://0x.org", role: "Swap API v2, where the asset is authorized · non-US only" },
      { name: "CoW Protocol", mark: "cowswap", color: "#012f7a", url: "https://cow.fi", role: "Signed orders: gasless swaps, limit orders" },
    ],
  },
  {
    id: "earn",
    title: "Earn",
    blurb: "Venues are discovered at runtime for each asset; nothing is listed unless the protocol really has a market.",
    items: [
      { name: "Morpho", mark: "morpho", color: "#2470ff", url: "https://morpho.org", role: "USDC vaults" },
      { name: "Aave", mark: "aave", color: "#b6509e", url: "https://aave.com", role: "USDC supply (V3)" },
      { name: "Compound", mark: "compound-v3", color: "#00d395", url: "https://compound.finance", role: "USDC supply (v3)" },
      { name: "Aerodrome", mark: "aerodrome", color: "#2563eb", url: "https://aerodrome.finance", role: "Stock / USDC pools, LP positions" },
      { name: "Uniswap", mark: "uniswap", color: "#ff007a", url: "https://app.uniswap.org", role: "Stock / USDC pools, LP positions" },
    ],
  },
  {
    id: "data",
    title: "Prices and market data",
    blurb: "Three separate prices: Chainlink reference, DEX market price, and the executable quote you trade at.",
    items: [
      { name: "Chainlink", mark: "chainlink", color: "#2a5ada", url: "https://chain.link", role: "Reference stock prices, staleness" },
      { name: "DexScreener", mark: null, color: "#0f172a", url: "https://dexscreener.com/base", role: "Live DEX price and liquidity" },
      { name: "GeckoTerminal", mark: "geckoterminal", color: "#0b3d2e", url: "https://www.geckoterminal.com/base", role: "Candles, pools, volume" },
      { name: "CoinGecko", mark: null, color: "#8dc63f", url: "https://www.coingecko.com", role: "Optional paid onchain API" },
    ],
  },
  {
    id: "base",
    title: "Built on Base",
    blurb: "Base-native pieces that make the app feel simple: passkey accounts, names, attribution, fast confirmations.",
    items: [
      { name: "Coinbase Tokenized Stocks", mark: null, color: "#0052ff", url: "https://www.base.org/stocks", role: "B20 assets, registry, oracles" },
      { name: "Base Account", mark: null, color: "#0000ff", url: "https://docs.base.org/sdks/base-account/overview", role: "Passkey wallet, atomic batches, sponsored gas" },
      { name: "Basenames", mark: null, color: "#0000ff", url: "https://www.base.org/names", role: "Send to alice.base.eth" },
      { name: "Builder Codes", mark: null, color: "#0000ff", url: "https://docs.base.org/specifications/builder-codes/for-app-developers", role: "ERC-8021 attribution on every transaction" },
      { name: "Flashblocks", mark: null, color: "#0000ff", url: "https://docs.base.org/specifications/flashblocks", role: "Preconfirmed status in ~200 ms" },
      { name: "Reown AppKit", mark: null, color: "#008847", url: "https://reown.com", role: "Wallet modal, MetaMask, Rabby, WalletConnect" },
    ],
  },
  {
    id: "funding",
    title: "Funding",
    blurb: "Ways to get USDC onto Base without leaving the app.",
    items: [
      { name: "LI.FI", mark: "li.fi", color: "#5c67ff", url: "https://li.fi", role: "Bridge from 20+ chains" },
      { name: "Coinbase", mark: null, color: "#0052ff", url: "https://www.coinbase.com", role: "Withdraw USDC on Base to your address" },
    ],
  },
];

/** The marks shown in the footer strip: one per distinct name, trading and earn first. */
export const FOOTER_INTEGRATIONS: Integration[] = (() => {
  const seen = new Set<string>();
  const out: Integration[] = [];
  for (const g of INTEGRATIONS) {
    for (const i of g.items) {
      if (seen.has(i.name)) continue;
      seen.add(i.name);
      out.push(i);
    }
  }
  return out;
})();

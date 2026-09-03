import type { PortfolioTemplate } from "@/domain/portfolio";

/**
 * Seed portfolio templates. These are TEMPLATES, not investment recommendations.
 * Persisted to the database on first run; the DB is the runtime source of truth.
 * Assets are referenced by canonical contract address only.
 */
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const MSFT = "0xB200000000000000000000Ab99cFa739E253872B";
const GOOGL = "0xb2000000000000000000002D0BA3164cc74f58B7";
const AMZN = "0xb200000000000000000000d9192b6B456483C2E8";
const META = "0xb2000000000000000000008bC8786B856E61707C";
const AAPL = "0xb200000000000000000000C2e324d24d7eEcd1fb";
const TSLA = "0xb2000000000000000000001e800a7f5189430cD0";
const COIN = "0xb200000000000000000000c85a31389D71F3ecfb";
const CRCL = "0xB20000000000000000000019f6E7C675b73C2e4D";
const MSTR = "0xb2000000000000000000004884b426556b92883d";
const INTC = "0xB2000000000000000000004AFF16039bA04bdFBc";
const SNDK = "0xb200000000000000000000397293Cb8cda9a10c5";

export const SEED_TEMPLATES: PortfolioTemplate[] = [
  {
    id: "tpl_ai_infra",
    slug: "ai-infrastructure",
    name: "AI Infrastructure",
    description: "Chips, cloud and platforms that power AI workloads. A template, not a recommendation.",
    active: true,
    allocations: [
      { assetAddress: NVDA, weightBps: 3500 },
      { assetAddress: MSFT, weightBps: 2500 },
      { assetAddress: GOOGL, weightBps: 2000 },
      { assetAddress: AMZN, weightBps: 1500 },
      { assetAddress: INTC, weightBps: 500 },
    ],
  },
  {
    id: "tpl_mega_tech",
    slug: "mega-tech",
    name: "Mega Tech",
    description: "Equal-ish weights across the largest technology names. A template, not a recommendation.",
    active: true,
    allocations: [
      { assetAddress: AAPL, weightBps: 2000 },
      { assetAddress: MSFT, weightBps: 2000 },
      { assetAddress: GOOGL, weightBps: 1500 },
      { assetAddress: AMZN, weightBps: 1500 },
      { assetAddress: META, weightBps: 1500 },
      { assetAddress: NVDA, weightBps: 1500 },
    ],
  },
  {
    id: "tpl_crypto_economy",
    slug: "crypto-economy",
    name: "Crypto Economy",
    description: "Public companies with revenue or balance sheets tied to crypto, with a USDC buffer. A template, not a recommendation.",
    active: true,
    allocations: [
      { assetAddress: COIN, weightBps: 3500 },
      { assetAddress: CRCL, weightBps: 2500 },
      { assetAddress: MSTR, weightBps: 2000 },
      { assetAddress: "USDC", weightBps: 2000 },
    ],
  },
  {
    id: "tpl_semis",
    slug: "semiconductors",
    name: "Semiconductors",
    description: "Compute and memory supply chain. A template, not a recommendation.",
    active: true,
    allocations: [
      { assetAddress: NVDA, weightBps: 5000 },
      { assetAddress: INTC, weightBps: 2500 },
      { assetAddress: SNDK, weightBps: 2500 },
    ],
  },
  {
    id: "tpl_balanced",
    slug: "balanced-core",
    name: "Balanced Core",
    description: "Broad exposure with a cash buffer for later buys. A template, not a recommendation.",
    active: true,
    allocations: [
      { assetAddress: AAPL, weightBps: 1500 },
      { assetAddress: MSFT, weightBps: 1500 },
      { assetAddress: NVDA, weightBps: 1500 },
      { assetAddress: GOOGL, weightBps: 1000 },
      { assetAddress: AMZN, weightBps: 1000 },
      { assetAddress: TSLA, weightBps: 1000 },
      { assetAddress: "USDC", weightBps: 2500 },
    ],
  },
];

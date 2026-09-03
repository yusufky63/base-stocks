import type { Address } from "viem";

/** Shared, non-personal brief generated a few times a day from headlines and prices. */
export interface MarketDigest {
  kind: "market";
  headline: string;
  summary: string;
  bullets: Array<{ ticker: string; note: string }>;
  mood: "calm" | "mixed" | "volatile";
  marketOpen: boolean;
  /** Number of headlines the model saw. */
  headlines: number;
  generatedAt: number;
  model: string;
}

/** Per-wallet daily account summary, generated on request and cached for the day. */
export interface PortfolioDigest {
  kind: "portfolio";
  owner: Address;
  headline: string;
  summary: string;
  highlights: string[];
  watch: string[];
  generatedAt: number;
  model: string;
}

export interface DigestRecord {
  key: string;
  kind: "market" | "portfolio";
  owner: Address | null;
  content: MarketDigest | PortfolioDigest;
  model: string;
  costUsd: number;
  createdAt: number;
  expiresAt: number;
}

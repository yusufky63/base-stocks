import { z } from "zod";

/**
 * Server-only environment. Never import from client components.
 * Private provider keys must not be prefixed with NEXT_PUBLIC_.
 */
const serverSchema = z.object({
  BASE_RPC_URL: z.string().url().optional(),
  FLASHBLOCKS_RPC_URL: z.string().url().optional(),
  ZEROX_API_KEY: z.string().min(1).optional(),
  /** Uniswap Trading API key (developers.uniswap.org); enables the Uniswap route behind KyberSwap. */
  UNISWAP_API_KEY: z.string().min(1).optional(),
  KYBER_CLIENT_ID: z.string().min(1).default("bstocks-app"),
  KYBER_API_KEY: z.string().min(1).optional(),
  /** OKX Onchain OS (DEX API): key + secret + passphrase, optional project id. */
  OKX_API_KEY: z.string().min(1).optional(),
  OKX_SECRET_KEY: z.string().min(1).optional(),
  OKX_PASSPHRASE: z.string().min(1).optional(),
  OKX_PROJECT_ID: z.string().min(1).optional(),
  COINGECKO_API_KEY: z.string().min(1).optional(),
  COINGECKO_API_TIER: z.enum(["demo", "pro"]).default("demo"),
  MARKET_WARMUP: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** "anthropic" (default, structured outputs) or "openai" (any OpenAI-compatible endpoint such as DeepSeek). */
  AI_PROVIDER: z.enum(["anthropic", "openai"]).optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).optional(),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(200).max(2000).optional(),
  MORPHO_API_URL: z.string().url().default("https://api.morpho.org/graphql"),
  /** Chainlink stock feeds heartbeat every 24h (spec); 26h leaves a margin before a reading counts as stale. */
  ORACLE_STALENESS_SECONDS: z.coerce.number().int().positive().default(93_600),
  ZEROX_SWAP_FEE_BPS: z.coerce.number().int().min(0).max(1000).optional(),
  ZEROX_SWAP_FEE_RECIPIENT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Comma-separated ISO country codes refused on trade/earn execution routes (compliance: US persons are ineligible). */
  GEOBLOCK_COUNTRIES: z.string().optional(),
  /** block = hard 451 for blocked countries; attest (default) = warning + self-certification cookie. */
  GEOBLOCK_MODE: z.enum(["block", "attest"]).optional(),
  ADMIN_API_TOKEN: z.string().min(16).optional(),
  /** Shared secret Vercel Cron sends as a Bearer token to /api/cron/refresh. */
  CRON_SECRET: z.string().min(16).optional(),
  AUTH_SECRET: z.string().min(16).optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must not be called in the browser");
  }
  if (cached) return cached;
  // dotenv loads `KEY=` as an empty string; treat blanks as unset so optional keys stay optional.
  const raw = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === undefined || v.trim() === "" ? undefined : v]));
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Public (browser-safe) environment. Only NEXT_PUBLIC_ values. */
export const publicEnv = {
  reownProjectId: process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  baseRpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "",
  flashblocksRpcUrl: process.env.NEXT_PUBLIC_FLASHBLOCKS_RPC_URL ?? "",
  builderCode: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE ?? "",
  paymasterUrl: process.env.NEXT_PUBLIC_PAYMASTER_URL ?? "",
} as const;

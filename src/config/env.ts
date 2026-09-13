import { z } from "zod";

/**
 * Server-only environment. Never import from client components.
 * Private provider keys must not be prefixed with NEXT_PUBLIC_.
 */
const serverSchema = z.object({
  BASE_RPC_URL: z.string().url().optional(),
  /** Second keyed RPC (dRPC); an equal member of the read rotation alongside the primary and CDP. */
  DRPC_RPC_URL: z.string().url().optional(),
  /**
   * How server reads divide between the keyed RPCs, as `alchemy=1,drpc=2,cdp=2` — slots, not
   * percentages. Unset means an even split. Tuning it needs no deploy, which is the point: a
   * provider that starts rate-limiting can be weighted down from the dashboard.
   */
  RPC_WEIGHTS: z.string().optional(),
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
  /** Same ceiling as `aiConfigFromEnv` clamps to (lib/ai-provider.ts); the two used to disagree and a value one accepted the other refused. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(200).max(3000).optional(),
  /**
   * Shared secret a server-to-server caller of the assistant (the Telegram bot) presents in
   * `x-bstocks-service`, together with the end user it relays in `x-end-user`. Quotas are then
   * metered per end user and per service instead of per IP. Unset means no service path exists.
   */
  ASSISTANT_SERVICE_TOKEN: z.string().min(16).optional(),
  /** Assistant turns one relayed end user may take a day (default 40). */
  AI_DAILY_LIMIT_PER_SERVICE_USER: z.coerce.number().int().min(0).optional(),
  /** Assistant turns the whole service may take a day (default 400), so one token cannot drain the global cap. */
  AI_DAILY_LIMIT_PER_SERVICE: z.coerce.number().int().min(0).optional(),
  MORPHO_API_URL: z.string().url().default("https://api.morpho.org/graphql"),
  /** Chainlink stock feeds heartbeat every 24h (spec); 26h leaves a margin before a reading counts as stale. */
  ORACLE_STALENESS_SECONDS: z.coerce.number().int().positive().default(93_600),
  /** Integrator fee on routes that can carry one (Kyber, Velora, CoW, 0x), in basis points; off without a recipient. Capped at 100 (1%). */
  INTEGRATOR_FEE_BPS: z.coerce.number().int().min(0).max(100).optional(),
  INTEGRATOR_FEE_RECIPIENT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  ZEROX_SWAP_FEE_BPS: z.coerce.number().int().min(0).max(1000).optional(),
  ZEROX_SWAP_FEE_RECIPIENT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Comma-separated ISO country codes refused on trade/earn execution routes (compliance: US persons are ineligible). */
  GEOBLOCK_COUNTRIES: z.string().optional(),
  /** block (default) = hard 451 for blocked countries; attest = warning + self-certification cookie, and has to be asked for. */
  GEOBLOCK_MODE: z.enum(["block", "attest"]).optional(),
  ADMIN_API_TOKEN: z.string().min(16).optional(),
  /** Shared secret Vercel Cron sends as a Bearer token to /api/cron/refresh. */
  CRON_SECRET: z.string().min(16).optional(),
  AUTH_SECRET: z.string().min(16).optional(),
  /**
   * Campaign signer for quest-gated gift pools. Server-only, never NEXT_PUBLIC_. Without it the
   * app still offers open and link-gated pools; only quest gating is unavailable. Compromise is
   * bounded by the pools that name this address as their gate and by their slot counts, so use a
   * dedicated key for campaigns and rotate it by creating new pools.
   */
  POOL_GATE_SIGNER_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "Expected a 32-byte hex private key")
    .optional(),
  /**
   * Keeper for AutoInvest plans: the account the contract lets trigger due runs. It pays gas and
   * chooses timing and route; it can never move more than a plan allows, and never to anywhere but
   * the plan owner. Server-only. Without it plans can still be run by their owners from the app.
   */
  AUTOMATION_KEEPER_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "Expected a 32-byte hex private key")
    .optional(),
  /** How many due plans one keeper tick may execute (serverless budget). */
  AUTOMATION_MAX_RUNS_PER_TICK: z.coerce.number().int().min(1).max(50).default(6),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;
let warnings: string[] = [];

/** Which keys may be dropped when malformed: anything the schema accepts as absent. */
function isOptionalKey(key: string): boolean {
  const field = (serverSchema.shape as Record<string, z.ZodType | undefined>)[key];
  return !!field && field.safeParse(undefined).success;
}

/**
 * Parse the environment, tolerating a malformed optional value.
 *
 * One bad optional setting used to take every route down: a `DRPC_RPC_URL` with a stray space or
 * an `AI_MAX_OUTPUT_TOKENS` one over the ceiling threw from `serverEnv()`, which every handler
 * calls, so the whole site answered 500 over a key it could have done without. An optional field
 * that fails now becomes undefined with a warning (logged once by `instrumentation.register`);
 * only a required or defaulted field that is genuinely broken still throws. Pure, for tests.
 */
export function parseServerEnv(source: Record<string, string | undefined>): { env: ServerEnv; warnings: string[] } {
  // dotenv loads `KEY=` as an empty string; treat blanks as unset so optional keys stay optional.
  const raw: Record<string, string | undefined> = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === undefined || v.trim() === "" ? undefined : v]));
  const dropped: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = serverSchema.safeParse(raw);
    if (parsed.success) return { env: parsed.data, warnings: dropped };
    let droppedAny = false;
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && raw[key] !== undefined && isOptionalKey(key)) {
        dropped.push(`${key}: ${issue.message} (ignored, treated as unset)`);
        delete raw[key];
        droppedAny = true;
      }
    }
    if (!droppedAny) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid server environment: ${issues}`);
    }
  }
  const final = serverSchema.safeParse(raw);
  if (!final.success) throw new Error(`Invalid server environment: ${final.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { env: final.data, warnings: dropped };
}

export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must not be called in the browser");
  }
  if (cached) return cached;
  const result = parseServerEnv(process.env);
  cached = result.env;
  warnings = result.warnings;
  return cached;
}

/**
 * The optional settings that were ignored because they were malformed. Empty when everything
 * parsed. Read after `serverEnv()`; `instrumentation.register` logs it once at boot so a typo in
 * the dashboard is seen instead of silently costing a provider.
 */
export function serverEnvWarnings(): string[] {
  serverEnv();
  return [...warnings];
}

/** Public (browser-safe) environment. Only NEXT_PUBLIC_ values. */
export const publicEnv = {
  reownProjectId: process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "",
  /** Official production origin as the fallback so share links, wallet metadata and manifests never point at localhost. */
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === "production" ? "https://basestocks.finance" : "http://localhost:3000"),
  baseRpcUrl: process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "",
  /** Base Builder Code (public, appended to calldata as an ERC-8021 suffix). An empty env value counts as unset. */
  builderCode: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE || "bc_71vd6x2w",
  paymasterUrl: process.env.NEXT_PUBLIC_PAYMASTER_URL ?? "",
  /** GiftPool deployment. Empty until the contract is deployed; the app then hides pools. */
  giftPoolAddress: process.env.NEXT_PUBLIC_GIFT_POOL_ADDRESS ?? "",
  /** AutoInvest deployment. Empty means plans are confirmed by hand only. */
  autoInvestAddress: process.env.NEXT_PUBLIC_AUTO_INVEST_ADDRESS ?? "",
} as const;

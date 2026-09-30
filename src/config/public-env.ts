/**
 * Public (browser-safe) environment. Only NEXT_PUBLIC_ values, and no imports: this file is
 * bundled into most pages, so it stays free of zod and of the server schema in `env.ts`.
 */
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

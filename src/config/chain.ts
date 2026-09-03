import type { Address } from "viem";

/** Base Mainnet chain id. All execution is verified against this value. */
export const BASE_CHAIN_ID = 8453 as const;

/** Base USDC (verify against official Base / Circle sources before production). */
export const USDC_ADDRESS: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Native ETH sentinel accepted by KyberSwap, Velora and 0x (lowercase form; mixed case is rejected). */
export const NATIVE_ETH: Address = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const NATIVE_ETH_DECIMALS = 18;
export const isNativeEth = (address: string): boolean => address.toLowerCase() === NATIVE_ETH;
export const USDC_DECIMALS = 6 as const;

/** WETH on Base (used only for reference/gas math, never as a stock). */
export const WETH_ADDRESS: Address = "0x4200000000000000000000000000000000000006";

/** B20 precompiles (docs.base.org/specifications/b20/reference/constants-addresses). */
export const B20_FACTORY_ADDRESS: Address = "0xB20f000000000000000000000000000000000000";
export const B20_ACTIVATION_REGISTRY_ADDRESS: Address = "0x8453000000000000000000000000000000000001";
export const B20_POLICY_REGISTRY_ADDRESS: Address = "0x8453000000000000000000000000000000000002";

/**
 * Coinbase Tokenized Stocks OracleRegistry.
 * Verified onchain: `getOracleParams(address token) -> (uint256 multiplier, bool paused)`.
 * This is the "registry pause flag" the Base docs tell integrators to monitor when reading Chainlink feeds.
 */
export const STOCK_ORACLE_REGISTRY_ADDRESS: Address = "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD";
/**
 * EOA that sent `createB20` for all 13 Coinbase Tokenized Stocks (blocks 49,145,181–49,145,336, via
 * deployer contract 0x4ba3e29e254f25e94e61c4c9d67b37027331534d). Verified onchain 2026-09-02. Dozens of
 * copycat "NVDAc"/"METAc" tokens exist from other EOAs, so discovery only trusts this creator.
 */
export const COINBASE_B20_CREATORS: readonly Address[] = ["0xe090ecbee12d4b6aee5e73ff60945f2545ef5c6f"];
export const COINBASE_B20_DEPLOYER: Address = "0x4ba3e29e254f25e94e61c4c9d67b37027331534d";

/** Basenames (github.com/base/basenames README, Base mainnet). */
export const BASENAMES_L2_RESOLVER_ADDRESS: Address = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
export const BASENAMES_REGISTRY_ADDRESS: Address = "0xb94704422c2a1e396835a571837aa5ae53285a95";
/** ENSIP-11 coin type for Base used by the reverse namespace `<addr>.80002105.reverse`. */
export const BASENAMES_REVERSE_COIN_TYPE_HEX = "80002105";

/** Multicall3 (canonical deployment, same address on Base). */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Public RPC fallbacks used only when no dedicated RPC is configured. */
export const PUBLIC_BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
] as const;

export const BASE_EXPLORER_URL = "https://basescan.org";

/** Reown AppKit wallet id for Base Account (docs.base.org/sdks/base-account/framework-integrations/reown). */
export const BASE_ACCOUNT_WALLET_ID = "fd20dc426fb37566d803205b19bbc1d4096b248ac04548e3cfb6b3a38bd033aa";

/** Chainlink stock feeds: 8 decimals, total-return, 24/5 hours. Staleness threshold is configurable. */
export const CHAINLINK_FEED_DECIMALS = 8 as const;
/** Default: consider the reference stale after 1 hour without an update. Always displayed, never hidden. */
export const DEFAULT_ORACLE_STALENESS_SECONDS = 60 * 60;

/** Minimum practical trade size for a single leg (USD). */
export const MIN_TRADE_USD = 1;
/** Default slippage for consumer trades, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Executable quotes are treated as short-lived. */
export const EXECUTABLE_QUOTE_TTL_MS = 30_000;

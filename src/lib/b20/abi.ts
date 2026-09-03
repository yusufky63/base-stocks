import { keccak256, parseAbi, stringToHex, type Hex } from "viem";

/**
 * B20 asset ABI. Every view below was verified against the live NVDAc precompile on
 * Base mainnet (2026-09-02). Do not add functions that have not been verified.
 */
export const b20AssetAbi = parseAbi([
  // ERC-20
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  // B20 asset
  "function multiplier() view returns (uint256)",
  "function WAD_PRECISION() view returns (uint256)",
  "function scaledBalanceOf(address account) view returns (uint256)",
  "function toScaledBalance(uint256 rawBalance) view returns (uint256)",
  "function toRawBalance(uint256 scaledBalance) view returns (uint256)",
  "function isPaused(uint8 feature) view returns (bool)",
  "function pausedFeatures() view returns (uint8[])",
  "function policyId(bytes32 policyScope) view returns (uint64)",
  "function contractURI() view returns (string)",
  "function supplyCap() view returns (uint128)",
  "function extraMetadata(string key) view returns (string)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  // Memo transfers (github.com/base/base-std src/interfaces/IB20.sol: bytes32 memo)
  "function transferWithMemo(address to, uint256 amount, bytes32 memo) returns (bool)",
  "function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo) returns (bool)",
  // Events (base-std IB20.sol / IB20Asset.sol)
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Memo(address indexed caller, bytes32 indexed memo)",
  "event Paused(address indexed updater, uint8[] features)",
  "event Unpaused(address indexed updater, uint8[] features)",
  "event MultiplierUpdated(uint256 multiplier)",
  "event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt)",
  "event ExtraMetadataUpdated(string key, string value)",
  "event Announcement(address indexed caller, string id, string description, string uri)",
  "event EndAnnouncement(string id)",
  "event ExtraMetadataUpdated(string key, string value)",
]);

export const b20FactoryAbi = parseAbi([
  "function isB20(address token) view returns (bool)",
  // base-std IB20Factory: variant 0 = ASSET (stocks), 1 = STABLECOIN. Topic0 0xfd9bf273… (verified on Base 2026-09-02).
  "event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)",
]);

/** IPolicyRegistry (verified selector 0x55a1179e for isAuthorized(uint64,address)). */
export const b20PolicyRegistryAbi = parseAbi([
  "function isAuthorized(uint64 policyId, address account) view returns (bool)",
  "function policyExists(uint64 policyId) view returns (bool)",
  "function policyAdmin(uint64 policyId) view returns (address)",
]);

/** Coinbase tokenized stock OracleRegistry (verified onchain). */
export const stockOracleRegistryAbi = parseAbi([
  "function getOracleParams(address token) view returns (uint256 multiplier, bool paused)",
]);

/** PausableFeature enum (base-std IB20.sol): TRANSFER, MINT, BURN, SEIZE. Only TRANSFER matters to holders. */
export const B20_PAUSABLE_FEATURE = {
  TRANSFER: 0,
  MINT: 1,
  BURN: 2,
  SEIZE: 3,
} as const;

/** Policy scopes are keccak256 of the scope name (docs: restrict-eligible-holders). */
export const B20_POLICY_SCOPE = {
  TRANSFER_SENDER: keccak256(stringToHex("TRANSFER_SENDER_POLICY")),
  TRANSFER_RECEIVER: keccak256(stringToHex("TRANSFER_RECEIVER_POLICY")),
  TRANSFER_EXECUTOR: keccak256(stringToHex("TRANSFER_EXECUTOR_POLICY")),
  MINT_RECEIVER: keccak256(stringToHex("MINT_RECEIVER_POLICY")),
} as const satisfies Record<string, Hex>;

/** Built-in policy ids. */
export const B20_POLICY_ALWAYS_ALLOW = 0n;

/** Custom error selectors (docs: errors-events index). Used to humanize reverts. */
export const B20_ERROR_SELECTORS: Record<string, string> = {
  "0xa43fec12": "PolicyForbids",
  "0xf9df5ac9": "ContractPaused",
  "0xdb42144d": "InsufficientBalance",
  "0x192b9e4e": "InsufficientAllowance",
  "0x9cfea583": "InvalidReceiver",
  "0x4c14f64c": "InvalidSender",
  "0x4b344b11": "SupplyCapExceeded",
  "0x2c5211c6": "InvalidAmount",
};

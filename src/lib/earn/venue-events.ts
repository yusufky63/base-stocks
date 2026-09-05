import { parseAbiItem, type Address, type Hash } from "viem";
import type { EarnActionRecord } from "@/db/repositories";
import { USDC_DECIMALS } from "@/config/chain";

/**
 * What the Earn venues say on the chain, turned into the app's own Earn records.
 *
 * A deposit made through the app is recorded by the browser after the wallet confirms it, and a
 * closed tab or a failed request loses it for good — the position is real, the record is not
 * there, and the statistics undercount. So the venues' own events are the source of truth:
 * Aave's `Supply`/`Withdraw`, an ERC-4626 vault's `Deposit`/`Withdraw`, Compound v3's
 * `Supply`/`Withdraw`. Everything here is pure; the service does the reading.
 */

export type VenueKind = "aave" | "erc4626" | "comet";

export interface EarnVenue {
  kind: VenueKind;
  address: Address;
  provider: string;
  opportunityId: string;
}

export const AAVE_SUPPLY = parseAbiItem("event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)");
export const AAVE_WITHDRAW = parseAbiItem("event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)");
export const ERC4626_DEPOSIT = parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)");
export const ERC4626_WITHDRAW = parseAbiItem("event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)");
export const COMET_SUPPLY = parseAbiItem("event Supply(address indexed from, address indexed dst, uint256 amount)");
export const COMET_WITHDRAW = parseAbiItem("event Withdraw(address indexed src, address indexed to, uint256 amount)");

/** One venue event, reduced to what a record needs. */
export interface VenueEvent {
  action: "deposit" | "withdraw";
  /** The wallet whose position changed (the position owner, not the relayer that sent the transaction). */
  wallet: Address;
  /** Underlying base units (USDC: 6 decimals). */
  amount: bigint;
  txHash: Hash;
  blockNumber: bigint;
  logIndex: number;
}

type Args = Record<string, unknown>;
const addr = (v: unknown): Address | null => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);
const big = (v: unknown): bigint | null => (typeof v === "bigint" ? v : null);

/**
 * Which field names the position owner in each event. Aave credits `onBehalfOf` on a supply and
 * debits `user` on a withdrawal; a vault credits and debits `owner`; Comet credits `dst` and
 * debits `src`. The sender of the transaction is not the owner when a relayer or a smart account
 * is involved, so it is never used.
 */
export function decodeVenueEvent(kind: VenueKind, action: "deposit" | "withdraw", args: Args, meta: { txHash: Hash; blockNumber: bigint; logIndex: number }): VenueEvent | null {
  let wallet: Address | null = null;
  let amount: bigint | null = null;
  if (kind === "aave") {
    wallet = addr(action === "deposit" ? args.onBehalfOf : args.user);
    amount = big(args.amount);
  } else if (kind === "erc4626") {
    wallet = addr(args.owner);
    amount = big(args.assets);
  } else {
    wallet = addr(action === "deposit" ? args.dst : args.src);
    amount = big(args.amount);
  }
  if (!wallet || amount === null || amount <= 0n) return null;
  return { action, wallet, amount, txHash: meta.txHash, blockNumber: meta.blockNumber, logIndex: meta.logIndex };
}

/** The id the browser would have used for the same transaction, so a late record never lands twice. */
export function earnRecordId(txHash: Hash, logIndex?: number): string {
  const base = `earn_${txHash.slice(2, 18).toLowerCase()}`;
  return logIndex === undefined ? base : `${base}_${logIndex}`;
}

/** An Earn record from a venue event: the same shape the browser writes, dated by the block. */
export function earnRecordFromEvent(venue: EarnVenue, ev: VenueEvent, blockTimeSec: number | undefined, id: string): EarnActionRecord {
  return {
    id,
    owner: ev.wallet,
    opportunityId: venue.opportunityId,
    provider: venue.provider,
    action: ev.action,
    amount: ev.amount.toString(),
    usdValue: Number(ev.amount) / 10 ** USDC_DECIMALS,
    txHash: ev.txHash,
    createdAt: blockTimeSec ? blockTimeSec * 1000 : Date.now(),
    // Read from the venue's own log: verified by construction.
    verifiedAt: Date.now(),
  };
}

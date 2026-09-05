import { decodeEventLog, encodeEventTopics, erc20Abi, type Abi, type Address, type Hex } from "viem";

/**
 * What a transaction receipt proves, read from its logs. Pure: hand it the logs and it answers;
 * the service around it fetches receipts and decides what to do with the answers.
 *
 * The rule these helpers serve: **an app record counts only once the chain shows the thing the
 * record claims** — the stock arriving in the buyer's wallet, leaving the seller's, the escrow
 * emitting `GiftCreated` for that escrow id, the pool emitting `PoolClaimed` for that recipient.
 * Who sent the transaction is never the test (a relayer or a bundler may have); what moved is.
 */
export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
}

export interface TokenMove {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  logIndex: number;
}

const lower = (s: string) => s.toLowerCase();
const TRANSFER_TOPIC = encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0]!.toLowerCase();

/** Every ERC-20 `Transfer` in the receipt, optionally for one token only. */
export function tokenMoves(logs: readonly ReceiptLog[], token?: Address): TokenMove[] {
  const only = token ? lower(token) : null;
  const out: TokenMove[] = [];
  for (const log of logs) {
    if (only && lower(log.address) !== only) continue;
    if (log.topics.length !== 3 || lower(log.topics[0] ?? "") !== TRANSFER_TOPIC) continue;
    try {
      const d = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]], eventName: "Transfer" });
      out.push({ token: log.address, from: d.args.from, to: d.args.to, value: d.args.value, logIndex: log.logIndex });
    } catch {
      // Not a Transfer (an Approval shares the topic count but not the signature).
    }
  }
  return out;
}

/** Net amount of `token` that ended up in (positive) or left (negative) `wallet` in this receipt. */
export function netFlow(moves: readonly TokenMove[], token: Address, wallet: Address): bigint {
  const t = lower(token);
  const w = lower(wallet);
  let net = 0n;
  for (const m of moves) {
    if (lower(m.token) !== t) continue;
    if (lower(m.to) === w) net += m.value;
    if (lower(m.from) === w) net -= m.value;
  }
  return net;
}

/**
 * The first event named `eventName` emitted by `address` whose decoded args satisfy `match`.
 * Returns the args, or null. Decoding errors on unrelated logs are ignored.
 */
export function findEvent<TArgs extends Record<string, unknown>>(logs: readonly ReceiptLog[], abi: Abi, address: Address, eventName: string, match?: (args: TArgs) => boolean): TArgs | null {
  const at = lower(address);
  for (const log of logs) {
    if (lower(log.address) !== at) continue;
    try {
      const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (d.eventName !== eventName) continue;
      const args = d.args as unknown as TArgs;
      if (!match || match(args)) return args;
    } catch {
      /* a different event of the same contract */
    }
  }
  return null;
}

/** True when any log in the receipt was emitted by one of `addresses`. */
export function touches(logs: readonly ReceiptLog[], addresses: readonly Address[]): boolean {
  const set = new Set(addresses.map(lower));
  return logs.some((l) => set.has(lower(l.address)));
}

/**
 * What a trade receipt says, for the record the app wrote.
 *
 * A buy is proven by the stock arriving in the recipient's wallet; a sell by it leaving the
 * seller's. The USDC that moved the other way is the settled amount — exact where the trade was
 * paid or received in USDC, absent for a buy paid in ETH.
 */
export function tradeFacts(logs: readonly ReceiptLog[], input: { owner: Address; assetAddress: Address; side: "buy" | "sell"; recipient?: Address; usdc: Address }): { ok: true; assetAmount: bigint; usdcAmount: bigint | null } | { ok: false; reason: string } {
  const moves = tokenMoves(logs);
  const party = input.side === "buy" ? (input.recipient ?? input.owner) : input.owner;
  const asset = netFlow(moves, input.assetAddress, party);
  if (input.side === "buy" && asset <= 0n) return { ok: false, reason: "The stock did not arrive in that wallet in this transaction." };
  if (input.side === "sell" && asset >= 0n) return { ok: false, reason: "The stock did not leave that wallet in this transaction." };
  // One transaction can buy several stocks at once (an AutoInvest run, an atomic basket). The USDC
  // that left the owner then paid for all of them, and no leg may claim the whole of it: the
  // settled amount is only known when exactly one stock moved for this party.
  const stocksMoved = new Set(moves.filter((m) => lower(m.token) !== lower(input.usdc) && (lower(m.to) === lower(party) || lower(m.from) === lower(party))).map((m) => lower(m.token)));
  const usdcNet = stocksMoved.size === 1 ? netFlow(moves, input.usdc, input.owner) : 0n;
  // Buy: USDC left the owner (negative net). Sell: USDC arrived (positive net). Otherwise unknown (ETH-paid, multi-leg, or routed oddly).
  const usdcAmount = input.side === "buy" ? (usdcNet < 0n ? -usdcNet : null) : usdcNet > 0n ? usdcNet : null;
  return { ok: true, assetAmount: input.side === "buy" ? asset : -asset, usdcAmount };
}

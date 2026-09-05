import type { Address, Hash } from "viem";
import { getSupabaseAdmin } from "./supabase";

/**
 * The app's own index of tokenized-stock transfers, for the wallets it knows.
 *
 * `wallet_index` says which wallets are indexed and which block range is covered for each;
 * `chain_transfers` holds every B20 `Transfer` that touched one of them. The timeline reads
 * this table instead of scanning logs per wallet, so its cost no longer grows with the number of
 * wallets; the sweep that fills it reads every stock's transfers once per block range and keeps
 * the rows that touch an indexed wallet.
 */
export interface IndexedTransfer {
  txHash: Hash;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds, when the block time was read. */
  blockTime?: number;
  token: Address;
  from: Address;
  to: Address;
  /** Raw units, as a string. */
  value: string;
}

export interface WalletIndexRow {
  wallet: Address;
  indexedFrom: number;
  indexedTo: number;
  createdAt: number;
}

export interface ChainTransferRepo {
  /** Insert, ignoring rows already there (the primary key is the log itself). */
  insertMany(rows: IndexedTransfer[]): Promise<number>;
  /** Transfers in or out of one wallet, newest first. */
  listByWallet(wallet: Address, limit?: number): Promise<IndexedTransfer[]>;
}

export interface WalletIndexRepo {
  get(wallet: Address): Promise<WalletIndexRow | null>;
  upsert(row: WalletIndexRow): Promise<void>;
  /** Every indexed wallet, lowercase. */
  listWallets(): Promise<Address[]>;
}

/* ------------------------------ Memory ------------------------------ */

const lower = (a: string) => a.toLowerCase();

export class MemoryChainTransferRepo implements ChainTransferRepo {
  private items = new Map<string, IndexedTransfer>();
  async insertMany(rows: IndexedTransfer[]) {
    let added = 0;
    for (const r of rows) {
      const k = `${lower(r.txHash)}:${r.logIndex}`;
      if (this.items.has(k)) continue;
      this.items.set(k, r);
      added += 1;
    }
    return added;
  }
  async listByWallet(wallet: Address, limit = 500) {
    const w = lower(wallet);
    return [...this.items.values()]
      .filter((t) => lower(t.from) === w || lower(t.to) === w)
      .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
      .slice(0, limit);
  }
}

export class MemoryWalletIndexRepo implements WalletIndexRepo {
  private items = new Map<string, WalletIndexRow>();
  async get(wallet: Address) {
    return this.items.get(lower(wallet)) ?? null;
  }
  async upsert(row: WalletIndexRow) {
    this.items.set(lower(row.wallet), { ...row, wallet: lower(row.wallet) as Address });
  }
  async listWallets() {
    return [...this.items.keys()] as Address[];
  }
}

/* ------------------------------ Supabase ------------------------------ */

type Row = Record<string, unknown>;

function sb() {
  const c = getSupabaseAdmin();
  if (!c) throw new Error("Supabase not configured");
  return c;
}

export class SupabaseChainTransferRepo implements ChainTransferRepo {
  private fromRow(r: Row): IndexedTransfer {
    return {
      txHash: String(r.tx_hash) as Hash,
      logIndex: Number(r.log_index),
      blockNumber: Number(r.block_number),
      blockTime: r.block_time === null || r.block_time === undefined ? undefined : Number(r.block_time),
      token: r.token as Address,
      from: r.from_address as Address,
      to: r.to_address as Address,
      value: String(r.value),
    };
  }
  async insertMany(rows: IndexedTransfer[]) {
    if (rows.length === 0) return 0;
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500).map((r) => ({
        tx_hash: lower(r.txHash),
        log_index: r.logIndex,
        block_number: r.blockNumber,
        block_time: r.blockTime ?? null,
        token: lower(r.token),
        from_address: lower(r.from),
        to_address: lower(r.to),
        value: r.value,
      }));
      const { data, error } = await sb().from("chain_transfers").upsert(batch, { onConflict: "tx_hash,log_index", ignoreDuplicates: true }).select("tx_hash");
      if (error) throw error;
      added += (data ?? []).length;
    }
    return added;
  }
  async listByWallet(wallet: Address, limit = 500) {
    const w = lower(wallet);
    const { data, error } = await sb().from("chain_transfers").select("*").or(`from_address.eq.${w},to_address.eq.${w}`).order("block_number", { ascending: false }).order("log_index", { ascending: false }).limit(limit);
    if (error) throw error;
    return ((data ?? []) as Row[]).map((r) => this.fromRow(r));
  }
}

export class SupabaseWalletIndexRepo implements WalletIndexRepo {
  async get(wallet: Address) {
    const { data, error } = await sb().from("wallet_index").select("*").eq("wallet", lower(wallet)).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as Row;
    return { wallet: r.wallet as Address, indexedFrom: Number(r.indexed_from), indexedTo: Number(r.indexed_to), createdAt: new Date(String(r.created_at)).getTime() };
  }
  async upsert(row: WalletIndexRow) {
    const { error } = await sb().from("wallet_index").upsert({ wallet: lower(row.wallet), indexed_from: row.indexedFrom, indexed_to: row.indexedTo, updated_at: new Date().toISOString() }, { onConflict: "wallet" });
    if (error) throw error;
  }
  async listWallets() {
    const out: Address[] = [];
    for (let from = 0; from < 20_000; from += 1_000) {
      const { data, error } = await sb().from("wallet_index").select("wallet").range(from, from + 999);
      if (error) throw error;
      const page = (data ?? []) as Row[];
      out.push(...page.map((r) => String(r.wallet).toLowerCase() as Address));
      if (page.length < 1_000) break;
    }
    return out;
  }
}

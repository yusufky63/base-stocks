import type { Address, Hash, Hex } from "viem";
import type { PoolClaim, PoolLeg, PoolRecord, Quest } from "@/domain/pool";
import { getSupabaseAdmin } from "./supabase";

/* ------------------------------ Interfaces ------------------------------ */

export interface PoolRepo {
  create(p: PoolRecord): Promise<PoolRecord>;
  update(id: string, patch: Partial<PoolRecord>): Promise<PoolRecord | null>;
  get(id: string): Promise<PoolRecord | null>;
  getByOnchainId(onchainId: Hex): Promise<PoolRecord | null>;
  listByCreator(creator: Address): Promise<PoolRecord[]>;
  /** Public directory: submitted pools only, verified ones first. */
  listPublic(limit: number): Promise<PoolRecord[]>;
  /** Pools that could still receive claims, for the reconciliation sweep. */
  listOpen(limit: number): Promise<PoolRecord[]>;
}

export interface PoolClaimRepo {
  /** Insert-or-keep. Returns null when this address already has a row (one share per address). */
  claimOnce(c: PoolClaim): Promise<PoolClaim | null>;
  update(poolId: string, claimant: Address, patch: Partial<PoolClaim>): Promise<PoolClaim | null>;
  get(poolId: string, claimant: Address): Promise<PoolClaim | null>;
  listByPool(poolId: string, limit?: number): Promise<PoolClaim[]>;
  listByClaimant(claimant: Address, limit?: number): Promise<PoolClaim[]>;
  countByPool(poolId: string): Promise<number>;
}

/* ------------------------------ Memory ------------------------------ */

const lower = (a: string) => a.toLowerCase();
const key = (poolId: string, claimant: string) => `${poolId}:${lower(claimant)}`;

export class MemoryPoolRepo implements PoolRepo {
  private items = new Map<string, PoolRecord>();
  async create(p: PoolRecord) {
    this.items.set(p.id, p);
    return p;
  }
  async update(id: string, patch: Partial<PoolRecord>) {
    const cur = this.items.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.items.set(id, next);
    return next;
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
  async getByOnchainId(onchainId: Hex) {
    return [...this.items.values()].find((p) => lower(p.onchainId) === lower(onchainId)) ?? null;
  }
  async listByCreator(creator: Address) {
    return [...this.items.values()].filter((p) => lower(p.creator) === lower(creator)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async listPublic(limit: number) {
    return [...this.items.values()]
      .filter((p) => p.visibility === "public" && p.status !== "draft" && p.status !== "failed")
      .sort((a, b) => Number(b.verified) - Number(a.verified) || b.createdAt - a.createdAt)
      .slice(0, limit);
  }
  async listOpen(limit: number) {
    const now = Date.now();
    return [...this.items.values()].filter((p) => p.status === "submitted" || (p.status === "live" && p.expiry > now)).slice(0, limit);
  }
}

export class MemoryPoolClaimRepo implements PoolClaimRepo {
  private items = new Map<string, PoolClaim>();
  async claimOnce(c: PoolClaim) {
    const k = key(c.poolId, c.claimant);
    if (this.items.has(k)) return null;
    this.items.set(k, c);
    return c;
  }
  async update(poolId: string, claimant: Address, patch: Partial<PoolClaim>) {
    const k = key(poolId, claimant);
    const cur = this.items.get(k);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.items.set(k, next);
    return next;
  }
  async get(poolId: string, claimant: Address) {
    return this.items.get(key(poolId, claimant)) ?? null;
  }
  async listByPool(poolId: string, limit = 500) {
    return [...this.items.values()].filter((c) => c.poolId === poolId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async listByClaimant(claimant: Address, limit = 200) {
    return [...this.items.values()].filter((c) => lower(c.claimant) === lower(claimant)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }
  async countByPool(poolId: string) {
    return [...this.items.values()].filter((c) => c.poolId === poolId).length;
  }
}

/* ------------------------------ Supabase ------------------------------ */

type Row = Record<string, unknown>;

function sb() {
  const c = getSupabaseAdmin();
  if (!c) throw new Error("Supabase is not configured");
  return c;
}

export class SupabasePoolRepo implements PoolRepo {
  private toRow(p: Partial<PoolRecord>): Row {
    const r: Row = {};
    if (p.id !== undefined) r.id = p.id;
    if (p.onchainId !== undefined) r.onchain_id = p.onchainId.toLowerCase();
    if (p.creator !== undefined) r.creator = p.creator.toLowerCase();
    if (p.gateMode !== undefined) r.gate_mode = p.gateMode;
    if (p.gateAddress !== undefined) r.gate_address = p.gateAddress.toLowerCase();
    if (p.slots !== undefined) r.slots = p.slots;
    if (p.expiry !== undefined) r.expiry = p.expiry;
    if (p.lockedUntil !== undefined) r.locked_until = p.lockedUntil;
    if (p.visibility !== undefined) r.visibility = p.visibility;
    if (p.verified !== undefined) r.verified = p.verified;
    if (p.title !== undefined) r.title = p.title;
    if (p.message !== undefined) r.message = p.message;
    if (p.quests !== undefined) r.quests_json = p.quests;
    if (p.memo !== undefined) r.memo = p.memo;
    if (p.txHash !== undefined) r.tx_hash = p.txHash;
    if (p.status !== undefined) r.status = p.status;
    if (p.createdAt !== undefined) r.created_at = new Date(p.createdAt).toISOString();
    return r;
  }

  private fromRow(r: Row, legs: Row[]): PoolRecord {
    return {
      id: String(r.id),
      onchainId: r.onchain_id as Hex,
      creator: r.creator as Address,
      gateMode: r.gate_mode as PoolRecord["gateMode"],
      gateAddress: r.gate_address as Address,
      slots: Number(r.slots),
      legs: legs
        .filter((l) => l.pool_id === r.id)
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((l) => ({ token: l.token as Address, amountPerClaim: String(l.amount_per_claim) }) satisfies PoolLeg),
      expiry: Number(r.expiry),
      lockedUntil: Number(r.locked_until ?? 0),
      visibility: r.visibility as PoolRecord["visibility"],
      verified: Boolean(r.verified),
      title: (r.title as string | null) ?? undefined,
      message: (r.message as string | null) ?? undefined,
      quests: (r.quests_json as Quest[] | null) ?? [],
      memo: r.memo as Hex,
      txHash: (r.tx_hash as Hash | null) ?? undefined,
      status: r.status as PoolRecord["status"],
      createdAt: new Date(String(r.created_at)).getTime(),
    };
  }

  private async withLegs(rows: Row[]): Promise<PoolRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => String(r.id));
    const { data, error } = await sb().from("gift_pool_legs").select("*").in("pool_id", ids);
    if (error) throw error;
    const legs = (data ?? []) as Row[];
    return rows.map((r) => this.fromRow(r, legs));
  }

  async create(p: PoolRecord) {
    const { error } = await sb().from("gift_pools").insert(this.toRow(p));
    if (error) throw error;
    if (p.legs.length > 0) {
      const { error: legError } = await sb()
        .from("gift_pool_legs")
        .insert(p.legs.map((l, i) => ({ pool_id: p.id, position: i, token: l.token.toLowerCase(), amount_per_claim: l.amountPerClaim })));
      if (legError) throw legError;
    }
    return p;
  }

  async update(id: string, patch: Partial<PoolRecord>) {
    const { error } = await sb().from("gift_pools").update(this.toRow(patch)).eq("id", id);
    if (error) throw error;
    return this.get(id);
  }

  async get(id: string) {
    const { data, error } = await sb().from("gift_pools").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return (await this.withLegs([data as Row]))[0] ?? null;
  }

  async getByOnchainId(onchainId: Hex) {
    const { data, error } = await sb().from("gift_pools").select("*").eq("onchain_id", onchainId.toLowerCase()).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return (await this.withLegs([data as Row]))[0] ?? null;
  }

  async listByCreator(creator: Address) {
    const { data, error } = await sb().from("gift_pools").select("*").eq("creator", creator.toLowerCase()).order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    return this.withLegs((data ?? []) as Row[]);
  }

  async listPublic(limit: number) {
    const { data, error } = await sb()
      .from("gift_pools")
      .select("*")
      .eq("visibility", "public")
      .in("status", ["submitted", "live", "cancelled", "expired"])
      .order("verified", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return this.withLegs((data ?? []) as Row[]);
  }

  async listOpen(limit: number) {
    const { data, error } = await sb()
      .from("gift_pools")
      .select("*")
      .in("status", ["submitted", "live"])
      .gt("expiry", Date.now())
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return this.withLegs((data ?? []) as Row[]);
  }
}

export class SupabasePoolClaimRepo implements PoolClaimRepo {
  private toRow(c: Partial<PoolClaim>): Row {
    const r: Row = {};
    if (c.poolId !== undefined) r.pool_id = c.poolId;
    if (c.claimant !== undefined) r.claimant = c.claimant.toLowerCase();
    if (c.status !== undefined) r.status = c.status;
    if (c.questProof !== undefined) r.quest_proof = c.questProof;
    if (c.txHash !== undefined) r.tx_hash = c.txHash;
    if (c.blockNumber !== undefined) r.block_number = c.blockNumber;
    if (c.createdAt !== undefined) r.created_at = new Date(c.createdAt).toISOString();
    return r;
  }

  private fromRow(r: Row): PoolClaim {
    return {
      poolId: String(r.pool_id),
      claimant: r.claimant as Address,
      status: r.status as PoolClaim["status"],
      questProof: (r.quest_proof as Record<string, unknown> | null) ?? {},
      txHash: (r.tx_hash as Hash | null) ?? undefined,
      blockNumber: r.block_number !== null && r.block_number !== undefined ? Number(r.block_number) : undefined,
      createdAt: new Date(String(r.created_at)).getTime(),
    };
  }

  /**
   * The primary key (pool_id, claimant) is the real guard: two parallel requests from the same
   * address race into the same row and exactly one insert wins. `ignoreDuplicates` turns the
   * loser into an empty result instead of an error.
   */
  async claimOnce(c: PoolClaim) {
    const { data, error } = await sb().from("gift_pool_claims").upsert(this.toRow(c), { onConflict: "pool_id,claimant", ignoreDuplicates: true }).select("*");
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    return rows.length > 0 ? this.fromRow(rows[0]!) : null;
  }

  async update(poolId: string, claimant: Address, patch: Partial<PoolClaim>) {
    const { data, error } = await sb()
      .from("gift_pool_claims")
      .update(this.toRow(patch))
      .eq("pool_id", poolId)
      .eq("claimant", claimant.toLowerCase())
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }

  async get(poolId: string, claimant: Address) {
    const { data, error } = await sb().from("gift_pool_claims").select("*").eq("pool_id", poolId).eq("claimant", claimant.toLowerCase()).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }

  async listByPool(poolId: string, limit = 500) {
    const { data, error } = await sb().from("gift_pool_claims").select("*").eq("pool_id", poolId).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return ((data ?? []) as Row[]).map((r) => this.fromRow(r));
  }

  async listByClaimant(claimant: Address, limit = 200) {
    const { data, error } = await sb().from("gift_pool_claims").select("*").eq("claimant", claimant.toLowerCase()).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return ((data ?? []) as Row[]).map((r) => this.fromRow(r));
  }

  async countByPool(poolId: string) {
    const { count, error } = await sb().from("gift_pool_claims").select("*", { count: "exact", head: true }).eq("pool_id", poolId);
    if (error) throw error;
    return count ?? 0;
  }
}

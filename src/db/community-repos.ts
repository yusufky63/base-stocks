import type { Address } from "viem";
import type { AutomationRule, CommunityBasket, PortfolioSnapshotRow, Profile } from "@/domain/community";
import { getSupabaseAdmin } from "./supabase";

/* ------------------------------ Interfaces ------------------------------ */

export interface ProfileRepo {
  get(address: Address): Promise<Profile | null>;
  getByHandle(handle: string): Promise<Profile | null>;
  upsert(p: Profile): Promise<Profile>;
  touch(address: Address): Promise<void>;
}
export interface BasketRepo {
  list(opts: { sort: "votes" | "new"; limit: number }): Promise<CommunityBasket[]>;
  get(id: string): Promise<CommunityBasket | null>;
  create(b: CommunityBasket): Promise<CommunityBasket>;
  listByOwner(owner: Address): Promise<CommunityBasket[]>;
  /** Toggle vote; returns the new state. */
  vote(id: string, voter: Address): Promise<{ voted: boolean; votes: number }>;
  hasVoted(id: string, voter: Address): Promise<boolean>;
  incrementClones(id: string): Promise<void>;
}
export interface SnapshotRepo {
  record(row: PortfolioSnapshotRow): Promise<void>;
  list(address: Address, days: number): Promise<PortfolioSnapshotRow[]>;
}
export interface AutomationRepo {
  list(owner: Address): Promise<AutomationRule[]>;
  create(rule: AutomationRule): Promise<AutomationRule>;
  update(id: string, owner: Address, patch: Partial<AutomationRule>): Promise<AutomationRule | null>;
  remove(id: string, owner: Address): Promise<void>;
}

/* ------------------------------ Memory ------------------------------ */

const lower = (a: string) => a.toLowerCase();

export class MemoryProfileRepo implements ProfileRepo {
  private items = new Map<string, Profile>();
  async get(address: Address) {
    return this.items.get(lower(address)) ?? null;
  }
  async getByHandle(handle: string) {
    return [...this.items.values()].find((p) => p.handle?.toLowerCase() === handle.toLowerCase()) ?? null;
  }
  async upsert(p: Profile) {
    this.items.set(lower(p.address), p);
    return p;
  }
  async touch(address: Address) {
    if (!this.items.has(lower(address))) this.items.set(lower(address), { address, isPublic: true, createdAt: Date.now(), updatedAt: Date.now() });
  }
}

export class MemoryBasketRepo implements BasketRepo {
  private items = new Map<string, CommunityBasket>();
  private votes = new Map<string, Set<string>>();
  async list(opts: { sort: "votes" | "new"; limit: number }) {
    const all = [...this.items.values()];
    all.sort((a, b) => (opts.sort === "votes" ? b.votes - a.votes || b.createdAt - a.createdAt : b.createdAt - a.createdAt));
    return all.slice(0, opts.limit);
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
  async create(b: CommunityBasket) {
    this.items.set(b.id, b);
    return b;
  }
  async listByOwner(owner: Address) {
    return [...this.items.values()].filter((b) => lower(b.owner) === lower(owner));
  }
  async vote(id: string, voter: Address) {
    const b = this.items.get(id);
    if (!b) return { voted: false, votes: 0 };
    const set = this.votes.get(id) ?? new Set<string>();
    const key = lower(voter);
    const voted = !set.has(key);
    if (voted) set.add(key);
    else set.delete(key);
    this.votes.set(id, set);
    b.votes = set.size;
    return { voted, votes: b.votes };
  }
  async hasVoted(id: string, voter: Address) {
    return this.votes.get(id)?.has(lower(voter)) ?? false;
  }
  async incrementClones(id: string) {
    const b = this.items.get(id);
    if (b) b.clones += 1;
  }
}

export class MemorySnapshotRepo implements SnapshotRepo {
  private items = new Map<string, PortfolioSnapshotRow>();
  async record(row: PortfolioSnapshotRow) {
    this.items.set(`${lower(row.address)}:${row.day}`, row);
  }
  async list(address: Address, days: number) {
    return [...this.items.values()]
      .filter((r) => lower(r.address) === lower(address))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-days);
  }
}

export class MemoryAutomationRepo implements AutomationRepo {
  private items = new Map<string, AutomationRule>();
  async list(owner: Address) {
    return [...this.items.values()].filter((r) => lower(r.owner) === lower(owner)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async create(rule: AutomationRule) {
    this.items.set(rule.id, rule);
    return rule;
  }
  async update(id: string, owner: Address, patch: Partial<AutomationRule>) {
    const cur = this.items.get(id);
    if (!cur || lower(cur.owner) !== lower(owner)) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.items.set(id, next);
    return next;
  }
  async remove(id: string, owner: Address) {
    const cur = this.items.get(id);
    if (cur && lower(cur.owner) === lower(owner)) this.items.delete(id);
  }
}

/* ------------------------------ Supabase ------------------------------ */

type Row = Record<string, unknown>;
function sb() {
  const c = getSupabaseAdmin();
  if (!c) throw new Error("Supabase not configured");
  return c;
}
const ts = (v: unknown) => new Date(String(v)).getTime();

export class SupabaseProfileRepo implements ProfileRepo {
  private fromRow(r: Row): Profile {
    return {
      address: r.wallet_address as Address,
      handle: (r.handle as string | null) ?? undefined,
      displayName: (r.display_name as string | null) ?? undefined,
      bio: (r.bio as string | null) ?? undefined,
      isPublic: Boolean(r.is_public),
      createdAt: ts(r.created_at),
      updatedAt: ts(r.updated_at),
    };
  }
  async get(address: Address) {
    const { data, error } = await sb().from("profiles").select("*").eq("wallet_address", lower(address)).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async getByHandle(handle: string) {
    const { data, error } = await sb().from("profiles").select("*").ilike("handle", handle).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async upsert(p: Profile) {
    const { error } = await sb()
      .from("profiles")
      .upsert({ wallet_address: lower(p.address), handle: p.handle ?? null, display_name: p.displayName ?? null, bio: p.bio ?? null, is_public: p.isPublic, updated_at: new Date().toISOString() }, { onConflict: "wallet_address" });
    if (error) throw error;
    return p;
  }
  async touch(address: Address) {
    const { error } = await sb().from("profiles").upsert({ wallet_address: lower(address) }, { onConflict: "wallet_address", ignoreDuplicates: true });
    if (error) throw error;
  }
}

export class SupabaseBasketRepo implements BasketRepo {
  private fromRow(r: Row): CommunityBasket {
    return {
      id: String(r.id),
      owner: r.owner as Address,
      name: String(r.name),
      description: String(r.description ?? ""),
      allocations: (r.allocations_json as CommunityBasket["allocations"]) ?? [],
      clones: Number(r.clones ?? 0),
      votes: Number(r.votes ?? 0),
      createdAt: ts(r.created_at),
      updatedAt: ts(r.updated_at),
    };
  }
  async list(opts: { sort: "votes" | "new"; limit: number }) {
    let q = sb().from("baskets").select("*").limit(opts.limit);
    q = opts.sort === "votes" ? q.order("votes", { ascending: false }).order("created_at", { ascending: false }) : q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
  async get(id: string) {
    const { data, error } = await sb().from("baskets").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async create(b: CommunityBasket) {
    const { error } = await sb().from("baskets").insert({ id: b.id, owner: lower(b.owner), name: b.name, description: b.description, allocations_json: b.allocations, clones: b.clones, votes: b.votes });
    if (error) throw error;
    return b;
  }
  async listByOwner(owner: Address) {
    const { data, error } = await sb().from("baskets").select("*").eq("owner", lower(owner)).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
  async hasVoted(id: string, voter: Address) {
    const { data, error } = await sb().from("basket_votes").select("basket_id").eq("basket_id", id).eq("voter", lower(voter)).maybeSingle();
    if (error) throw error;
    return !!data;
  }
  async vote(id: string, voter: Address) {
    const voted = !(await this.hasVoted(id, voter));
    if (voted) {
      const { error } = await sb().from("basket_votes").insert({ basket_id: id, voter: lower(voter) });
      if (error) throw error;
    } else {
      const { error } = await sb().from("basket_votes").delete().eq("basket_id", id).eq("voter", lower(voter));
      if (error) throw error;
    }
    const { count, error: e2 } = await sb().from("basket_votes").select("*", { count: "exact", head: true }).eq("basket_id", id);
    if (e2) throw e2;
    const votes = count ?? 0;
    const { error: e3 } = await sb().from("baskets").update({ votes, updated_at: new Date().toISOString() }).eq("id", id);
    if (e3) throw e3;
    return { voted, votes };
  }
  async incrementClones(id: string) {
    const cur = await this.get(id);
    if (!cur) return;
    const { error } = await sb().from("baskets").update({ clones: cur.clones + 1 }).eq("id", id);
    if (error) throw error;
  }
}

export class SupabaseSnapshotRepo implements SnapshotRepo {
  async record(row: PortfolioSnapshotRow) {
    const { error } = await sb().from("portfolio_snapshots").upsert({ wallet_address: lower(row.address), day: row.day, total_usd: row.totalUsd, holdings_json: row.holdings }, { onConflict: "wallet_address,day" });
    if (error) throw error;
  }
  async list(address: Address, days: number) {
    const { data, error } = await sb().from("portfolio_snapshots").select("*").eq("wallet_address", lower(address)).order("day", { ascending: false }).limit(days);
    if (error) throw error;
    return ((data ?? []) as Row[])
      .map((r) => ({ address: r.wallet_address as Address, day: String(r.day), totalUsd: Number(r.total_usd), holdings: (r.holdings_json as PortfolioSnapshotRow["holdings"]) ?? [], createdAt: ts(r.created_at) }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }
}

export class SupabaseAutomationRepo implements AutomationRepo {
  private fromRow(r: Row): AutomationRule {
    return {
      id: String(r.id),
      owner: r.wallet_address as Address,
      type: r.type as AutomationRule["type"],
      config: (r.config_json as AutomationRule["config"]) ?? {},
      status: (r.status as AutomationRule["status"]) ?? "proposed",
      nextRunAt: r.next_run_at ? ts(r.next_run_at) : undefined,
      lastRunAt: r.last_run_at ? ts(r.last_run_at) : undefined,
      createdAt: ts(r.created_at),
      updatedAt: r.updated_at ? ts(r.updated_at) : ts(r.created_at),
    };
  }
  async list(owner: Address) {
    const { data, error } = await sb().from("automation_rules").select("*").eq("wallet_address", lower(owner)).order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
  async create(rule: AutomationRule) {
    const { error } = await sb().from("automation_rules").insert({
      id: rule.id,
      wallet_address: lower(rule.owner),
      type: rule.type,
      config_json: rule.config,
      status: rule.status,
      next_run_at: rule.nextRunAt ? new Date(rule.nextRunAt).toISOString() : null,
      last_run_at: rule.lastRunAt ? new Date(rule.lastRunAt).toISOString() : null,
    });
    if (error) throw error;
    return rule;
  }
  async update(id: string, owner: Address, patch: Partial<AutomationRule>) {
    const row: Row = { updated_at: new Date().toISOString() };
    if (patch.status) row.status = patch.status;
    if (patch.config) row.config_json = patch.config;
    if (patch.nextRunAt !== undefined) row.next_run_at = patch.nextRunAt ? new Date(patch.nextRunAt).toISOString() : null;
    if (patch.lastRunAt !== undefined) row.last_run_at = patch.lastRunAt ? new Date(patch.lastRunAt).toISOString() : null;
    const { data, error } = await sb().from("automation_rules").update(row).eq("id", id).eq("wallet_address", lower(owner)).select("*").maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async remove(id: string, owner: Address) {
    const { error } = await sb().from("automation_rules").delete().eq("id", id).eq("wallet_address", lower(owner));
    if (error) throw error;
  }
}

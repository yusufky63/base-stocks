import type { Address } from "viem";
import type { AutomationRule, CommunityBasket, PortfolioSnapshotRow, Profile } from "@/domain/community";
import { getSupabaseAdmin } from "./supabase";

/* ------------------------------ Interfaces ------------------------------ */

export interface ProfileRepo {
  get(address: Address): Promise<Profile | null>;
  getByHandle(handle: string): Promise<Profile | null>;
  upsert(p: Profile): Promise<Profile>;
  touch(address: Address): Promise<void>;
  /** Every profile, for platform statistics (counts only; nothing personal is shown). */
  listAll(limit?: number): Promise<Profile[]>;
}
export interface BasketRepo {
  list(opts: { sort: "votes" | "new"; limit: number }): Promise<CommunityBasket[]>;
  get(id: string): Promise<CommunityBasket | null>;
  create(b: CommunityBasket): Promise<CommunityBasket>;
  listByOwner(owner: Address): Promise<CommunityBasket[]>;
  /** Toggle vote; returns the new state. */
  vote(id: string, voter: Address): Promise<{ voted: boolean; votes: number }>;
  hasVoted(id: string, voter: Address): Promise<boolean>;
  /** Count one clone per wallet: `counted` is false when this wallet already cloned the basket. */
  incrementClones(id: string, cloner: Address): Promise<{ counted: boolean; clones: number }>;
}
export interface SnapshotRepo {
  record(row: PortfolioSnapshotRow): Promise<void>;
  list(address: Address, days: number): Promise<PortfolioSnapshotRow[]>;
  /** Distinct wallets with at least one daily snapshot (wallets that opened their portfolio). */
  countWallets(): Promise<number>;
  listWallets(): Promise<Address[]>;
}
export interface AutomationRepo {
  list(owner: Address): Promise<AutomationRule[]>;
  /**
   * Every wallet's active plans that live in the AutoInvest contract (`config.mode === "auto"`),
   * oldest first, one page at a time: the keeper walks `offset` forward until a page comes back short.
   */
  listAuto(limit?: number, offset?: number): Promise<AutomationRule[]>;
  /** Every rule of every wallet, for platform statistics. */
  listAll(limit?: number): Promise<AutomationRule[]>;
  create(rule: AutomationRule): Promise<AutomationRule>;
  update(id: string, owner: Address, patch: Partial<AutomationRule>): Promise<AutomationRule | null>;
  /**
   * Write `config` only while the rule's `runningSince` still reads `expected` (null = not running).
   * One statement, so two keeper ticks that read the same rule cannot both believe they hold it.
   * Returns false when someone else got there first.
   */
  claimRun(id: string, owner: Address, config: AutomationRule["config"], expected: number | null): Promise<boolean>;
  remove(id: string, owner: Address): Promise<void>;
}

/* ------------------------------ Memory ------------------------------ */

const lower = (a: string) => a.toLowerCase();
const LIST_ALL_MAX = 5_000;

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
  async listAll(limit = LIST_ALL_MAX) {
    return [...this.items.values()].slice(0, limit);
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
  private cloners = new Map<string, Set<string>>();
  async incrementClones(id: string, cloner: Address) {
    const b = this.items.get(id);
    if (!b) return { counted: false, clones: 0 };
    const set = this.cloners.get(id) ?? new Set<string>();
    if (set.has(lower(cloner))) return { counted: false, clones: b.clones };
    set.add(lower(cloner));
    this.cloners.set(id, set);
    b.clones += 1;
    return { counted: true, clones: b.clones };
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
  async countWallets() {
    return (await this.listWallets()).length;
  }
  async listWallets() {
    return [...new Set([...this.items.values()].map((r) => lower(r.address)))] as Address[];
  }
}

export class MemoryAutomationRepo implements AutomationRepo {
  private items = new Map<string, AutomationRule>();
  async list(owner: Address) {
    return [...this.items.values()].filter((r) => lower(r.owner) === lower(owner)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async listAuto(limit = 200, offset = 0) {
    return [...this.items.values()]
      .filter((r) => r.config.mode === "auto" && r.status === "active")
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(offset, offset + limit);
  }
  async listAll(limit = LIST_ALL_MAX) {
    return [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
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
  async claimRun(id: string, owner: Address, config: AutomationRule["config"], expected: number | null) {
    const cur = this.items.get(id);
    if (!cur || lower(cur.owner) !== lower(owner)) return false;
    if ((cur.config.runningSince ?? null) !== expected) return false;
    this.items.set(id, { ...cur, config, updatedAt: Date.now() });
    return true;
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
    // Exact match on the lowercased handle the server stores. `ilike` treated `%` and `_` in the
    // segment as wildcards, so `/u/_` resolved to somebody's profile.
    const { data, error } = await sb().from("profiles").select("*").eq("handle", handle.toLowerCase()).maybeSingle();
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
  async listAll(limit = LIST_ALL_MAX) {
    const out: Profile[] = [];
    for (let from = 0; from < limit; from += 1_000) {
      const to = Math.min(from + 1_000, limit) - 1;
      const { data, error } = await sb().from("profiles").select("*").order("created_at", { ascending: false }).range(from, to);
      if (error) throw error;
      const page = (data ?? []) as Row[];
      out.push(...page.map((r) => this.fromRow(r)));
      if (page.length < to - from + 1) break;
    }
    return out;
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
  /**
   * Move a counter by `delta` in one statement (`increment_basket_counter`, migration
   * 2026-09-13-infra.sql). Until that function exists the read-modify-write stays as the fallback:
   * it can lose a race, but it cannot refuse a vote. Returns the new value.
   */
  private async bump(id: string, column: "votes" | "clones", delta: number, fallback: () => Promise<number>): Promise<number> {
    const { data, error } = await sb().rpc("increment_basket_counter", { p_id: id, p_column: column, p_delta: delta });
    if (!error && typeof data === "number") return data;
    if (error && !/function|does not exist|PGRST202|schema cache/i.test(error.message)) throw error;
    return fallback();
  }
  async vote(id: string, voter: Address) {
    // The row is the vote; the insert's primary key is what makes a double click one vote. Without
    // `ignoreDuplicates` two racing inserts would raise on the second and the toggle would flip
    // back; with it, the row count tells us which of the two actually counted.
    const already = await this.hasVoted(id, voter);
    let changed = false;
    if (!already) {
      const { data, error } = await sb().from("basket_votes").upsert({ basket_id: id, voter: lower(voter) }, { onConflict: "basket_id,voter", ignoreDuplicates: true }).select("basket_id");
      if (error) throw error;
      changed = ((data ?? []) as Row[]).length > 0;
    } else {
      const { data, error } = await sb().from("basket_votes").delete().eq("basket_id", id).eq("voter", lower(voter)).select("basket_id");
      if (error) throw error;
      changed = ((data ?? []) as Row[]).length > 0;
    }
    const voted = !already;
    const recount = async () => {
      const { count, error: e2 } = await sb().from("basket_votes").select("*", { count: "exact", head: true }).eq("basket_id", id);
      if (e2) throw e2;
      const votes = count ?? 0;
      const { error: e3 } = await sb().from("baskets").update({ votes, updated_at: new Date().toISOString() }).eq("id", id);
      if (e3) throw e3;
      return votes;
    };
    const votes = changed ? await this.bump(id, "votes", voted ? 1 : -1, recount) : ((await this.get(id))?.votes ?? 0);
    return { voted, votes };
  }
  async incrementClones(id: string, cloner: Address) {
    // One row per (basket, wallet): the second clone by the same wallet is not a second clone.
    // A deployment without the `basket_clones` table yet counts every call, as before.
    let counted = true;
    const { data, error } = await sb().from("basket_clones").upsert({ basket_id: id, cloner: lower(cloner) }, { onConflict: "basket_id,cloner", ignoreDuplicates: true }).select("basket_id");
    if (error) {
      if (!/does not exist|PGRST205|schema cache/i.test(error.message)) throw error;
    } else {
      counted = ((data ?? []) as Row[]).length > 0;
    }
    if (!counted) return { counted, clones: (await this.get(id))?.clones ?? 0 };
    const clones = await this.bump(id, "clones", 1, async () => {
      const cur = await this.get(id);
      if (!cur) return 0;
      const { error: e } = await sb().from("baskets").update({ clones: cur.clones + 1 }).eq("id", id);
      if (e) throw e;
      return cur.clones + 1;
    });
    return { counted, clones };
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
  async countWallets() {
    return (await this.listWallets()).length;
  }
  async listWallets() {
    const seen = new Set<string>();
    for (let from = 0; from < LIST_ALL_MAX; from += 1_000) {
      const { data, error } = await sb().from("portfolio_snapshots").select("wallet_address").range(from, from + 999);
      if (error) throw error;
      const page = (data ?? []) as Row[];
      for (const r of page) seen.add(lower(String(r.wallet_address)));
      if (page.length < 1_000) break;
    }
    return [...seen] as Address[];
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
  async listAuto(limit = 200, offset = 0) {
    const { data, error } = await sb().from("automation_rules").select("*").eq("status", "active").eq("config_json->>mode", "auto").order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + limit - 1);
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
  async listAll(limit = LIST_ALL_MAX) {
    const out: AutomationRule[] = [];
    for (let from = 0; from < limit; from += 1_000) {
      const to = Math.min(from + 1_000, limit) - 1;
      const { data, error } = await sb().from("automation_rules").select("*").order("created_at", { ascending: false }).range(from, to);
      if (error) throw error;
      const page = (data ?? []) as Row[];
      out.push(...page.map((r) => this.fromRow(r)));
      if (page.length < to - from + 1) break;
    }
    return out;
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
  async claimRun(id: string, owner: Address, config: AutomationRule["config"], expected: number | null) {
    // The filter and the write are one statement: PostgREST compares the JSON field as text, and
    // a lock taken in between reads as a different value, so the update matches nothing.
    let q = sb().from("automation_rules").update({ config_json: config, updated_at: new Date().toISOString() }).eq("id", id).eq("wallet_address", lower(owner));
    q = expected === null ? q.is("config_json->>runningSince", null) : q.eq("config_json->>runningSince", String(expected));
    const { data, error } = await q.select("id");
    if (error) throw error;
    return ((data ?? []) as Row[]).length > 0;
  }
  async remove(id: string, owner: Address) {
    const { error } = await sb().from("automation_rules").delete().eq("id", id).eq("wallet_address", lower(owner));
    if (error) throw error;
  }
}

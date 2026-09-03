import type { DigestRecord } from "@/domain/digest";
import type { Address, Hash } from "viem";
import type { GiftRecord } from "@/domain/gift";
import type { PortfolioExecution, PortfolioExecutionStep, PortfolioTemplate } from "@/domain/portfolio";
import { SEED_TEMPLATES } from "@/content/templates";
import { getSupabaseAdmin } from "./supabase";
import { metrics } from "@/lib/http";
import { resilient } from "./resilient";
import {
  MemoryAutomationRepo,
  MemoryBasketRepo,
  MemoryProfileRepo,
  MemoryReferralRepo,
  MemorySnapshotRepo,
  SupabaseAutomationRepo,
  SupabaseBasketRepo,
  SupabaseProfileRepo,
  SupabaseReferralRepo,
  SupabaseSnapshotRepo,
  type AutomationRepo,
  type BasketRepo,
  type ProfileRepo,
  type ReferralRepo,
  type SnapshotRepo,
} from "./community-repos";

/* ------------------------------ Types ------------------------------ */

export interface TradeRecord {
  id: string;
  owner: Address;
  side: "buy" | "sell";
  assetAddress: Address;
  sellAmount: string;
  buyAmount: string;
  usdValue: number | null;
  provider: string;
  txHash?: Hash;
  status: "submitted" | "confirmed" | "failed";
  recipient?: Address;
  createdAt: number;
}

/** App-side record of an Earn deposit/withdrawal (activity source; verified against the receipt). */
export interface EarnActionRecord {
  id: string;
  owner: Address;
  opportunityId: string;
  provider: string;
  action: "deposit" | "withdraw";
  /** Underlying amount in base units (USDC = 6 decimals). */
  amount: string;
  usdValue: number | null;
  txHash?: Hash;
  createdAt: number;
}

export interface DiscoveredAsset {
  address: Address;
  name: string;
  symbol: string;
  blockNumber: number;
  verification: "discovered" | "verified" | "disabled";
  updatedAt: number;
  /** Filled by discovery when the token looks like a Coinbase stock. */
  underlying?: string;
  chainlinkFeed?: Address;
  tags?: string[];
  /** Chainlink lists a "Coinbase <TICKER>" feed and the Coinbase oracle registry knows the token. */
  eligible?: boolean;
  autoVerified?: boolean;
  creator?: Address;
  reason?: string;
}

export interface TemplateRepo {
  list(activeOnly?: boolean): Promise<PortfolioTemplate[]>;
  getBySlug(slug: string): Promise<PortfolioTemplate | null>;
}
export interface GiftRepo {
  create(g: GiftRecord): Promise<GiftRecord>;
  update(id: string, patch: Partial<GiftRecord>): Promise<GiftRecord | null>;
  listByOwner(owner: Address): Promise<GiftRecord[]>;
  get(id: string): Promise<GiftRecord | null>;
}
export interface ExecutionRepo {
  create(e: PortfolioExecution): Promise<PortfolioExecution>;
  update(id: string, patch: Partial<Pick<PortfolioExecution, "status" | "updatedAt">> & { steps?: PortfolioExecutionStep[] }): Promise<PortfolioExecution | null>;
  get(id: string): Promise<PortfolioExecution | null>;
  listByOwner(owner: Address): Promise<PortfolioExecution[]>;
}
export interface TradeRepo {
  create(t: TradeRecord): Promise<TradeRecord>;
  update(id: string, patch: Partial<TradeRecord>): Promise<TradeRecord | null>;
  listByOwner(owner: Address): Promise<TradeRecord[]>;
  /** Submitted trades (with tx hash) since a timestamp, for community aggregates. */
  listSince(sinceMs: number, limit?: number): Promise<TradeRecord[]>;
}
export interface EarnActionRepo {
  create(a: EarnActionRecord): Promise<EarnActionRecord>;
  listByOwner(owner: Address): Promise<EarnActionRecord[]>;
}
export interface DigestRepo {
  get(key: string): Promise<DigestRecord | null>;
  put(r: DigestRecord): Promise<void>;
  latest(kind: DigestRecord["kind"], owner?: Address): Promise<DigestRecord | null>;
}
export interface WatchlistRepo {
  list(owner: Address): Promise<Address[]>;
  add(owner: Address, asset: Address): Promise<void>;
  remove(owner: Address, asset: Address): Promise<void>;
}
export interface DiscoveredAssetRepo {
  upsert(items: DiscoveredAsset[]): Promise<void>;
  list(): Promise<DiscoveredAsset[]>;
  setVerification(address: Address, v: DiscoveredAsset["verification"]): Promise<void>;
}

export interface Repos {
  templates: TemplateRepo;
  gifts: GiftRepo;
  executions: ExecutionRepo;
  trades: TradeRepo;
  watchlists: WatchlistRepo;
  discoveredAssets: DiscoveredAssetRepo;
  profiles: ProfileRepo;
  baskets: BasketRepo;
  referrals: ReferralRepo;
  snapshots: SnapshotRepo;
  automation: AutomationRepo;
  earnActions: EarnActionRepo;
  digests: DigestRepo;
  backend: "memory" | "supabase";
}

/* ------------------------------ Memory backend ------------------------------ */

const lower = (a: string) => a.toLowerCase();

class MemoryTemplateRepo implements TemplateRepo {
  async list(activeOnly = true) {
    return SEED_TEMPLATES.filter((t) => !activeOnly || t.active);
  }
  async getBySlug(slug: string) {
    return SEED_TEMPLATES.find((t) => t.slug === slug) ?? null;
  }
}

class MemoryGiftRepo implements GiftRepo {
  private items = new Map<string, GiftRecord>();
  async create(g: GiftRecord) {
    this.items.set(g.id, g);
    return g;
  }
  async update(id: string, patch: Partial<GiftRecord>) {
    const cur = this.items.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.items.set(id, next);
    return next;
  }
  async listByOwner(owner: Address) {
    return [...this.items.values()].filter((g) => lower(g.sender) === lower(owner) || lower(g.recipient) === lower(owner)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
}

class MemoryExecutionRepo implements ExecutionRepo {
  private items = new Map<string, PortfolioExecution>();
  async create(e: PortfolioExecution) {
    this.items.set(e.id, e);
    return e;
  }
  async update(id: string, patch: Partial<Pick<PortfolioExecution, "status" | "updatedAt">> & { steps?: PortfolioExecutionStep[] }) {
    const cur = this.items.get(id);
    if (!cur) return null;
    const next: PortfolioExecution = { ...cur, ...patch, steps: patch.steps ?? cur.steps, updatedAt: patch.updatedAt ?? Date.now() };
    this.items.set(id, next);
    return next;
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
  async listByOwner(owner: Address) {
    return [...this.items.values()].filter((e) => lower(e.owner) === lower(owner)).sort((a, b) => b.createdAt - a.createdAt);
  }
}

class MemoryTradeRepo implements TradeRepo {
  private items = new Map<string, TradeRecord>();
  async create(t: TradeRecord) {
    this.items.set(t.id, t);
    return t;
  }
  async update(id: string, patch: Partial<TradeRecord>) {
    const cur = this.items.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.items.set(id, next);
    return next;
  }
  async listByOwner(owner: Address) {
    return [...this.items.values()].filter((t) => lower(t.owner) === lower(owner)).sort((a, b) => b.createdAt - a.createdAt);
  }
  async listSince(sinceMs: number, limit = 2000) {
    return [...this.items.values()]
      .filter((t) => t.txHash && t.createdAt >= sinceMs)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}

class MemoryEarnActionRepo implements EarnActionRepo {
  private items = new Map<string, EarnActionRecord>();
  async create(a: EarnActionRecord) {
    this.items.set(a.id, a);
    return a;
  }
  async listByOwner(owner: Address) {
    return [...this.items.values()].filter((a) => lower(a.owner) === lower(owner)).sort((a, b) => b.createdAt - a.createdAt);
  }
}

class MemoryDigestRepo implements DigestRepo {
  private items = new Map<string, DigestRecord>();
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async put(r: DigestRecord) {
    this.items.set(r.key, r);
  }
  async latest(kind: DigestRecord["kind"], owner?: Address) {
    return [...this.items.values()].filter((r) => r.kind === kind && (!owner || lower(r.owner ?? "") === lower(owner))).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }
}

class MemoryWatchlistRepo implements WatchlistRepo {
  private items = new Map<string, Set<string>>();
  async list(owner: Address) {
    return [...(this.items.get(lower(owner)) ?? [])] as Address[];
  }
  async add(owner: Address, asset: Address) {
    const s = this.items.get(lower(owner)) ?? new Set<string>();
    s.add(asset);
    this.items.set(lower(owner), s);
  }
  async remove(owner: Address, asset: Address) {
    const s = this.items.get(lower(owner));
    if (!s) return;
    for (const a of s) if (lower(a) === lower(asset)) s.delete(a);
  }
}

class MemoryDiscoveredAssetRepo implements DiscoveredAssetRepo {
  private items = new Map<string, DiscoveredAsset>();
  async upsert(list: DiscoveredAsset[]) {
    for (const d of list) {
      const prev = this.items.get(lower(d.address));
      this.items.set(lower(d.address), { ...d, verification: prev?.verification ?? d.verification });
    }
  }
  async list() {
    return [...this.items.values()];
  }
  async setVerification(address: Address, v: DiscoveredAsset["verification"]) {
    const cur = this.items.get(lower(address));
    if (cur) this.items.set(lower(address), { ...cur, verification: v, updatedAt: Date.now() });
  }
}

/* ------------------------------ Supabase backend ------------------------------ */

type Row = Record<string, unknown>;

function sb() {
  const c = getSupabaseAdmin();
  if (!c) throw new Error("Supabase not configured");
  return c;
}

class SupabaseTemplateRepo implements TemplateRepo {
  private seeded = false;
  private async ensureSeeded() {
    if (this.seeded) return;
    const { count, error } = await sb().from("portfolio_templates").select("id", { count: "exact", head: true });
    if (error) throw error;
    if ((count ?? 0) === 0) {
      const { error: e1 } = await sb().from("portfolio_templates").upsert(
        SEED_TEMPLATES.map((t) => ({ id: t.id, slug: t.slug, name: t.name, description: t.description, active: t.active })),
      );
      if (e1) throw e1;
      const { error: e2 } = await sb().from("portfolio_template_allocations").upsert(
        SEED_TEMPLATES.flatMap((t) => t.allocations.map((a) => ({ template_id: t.id, asset_address_or_usdc: a.assetAddress, weight_bps: a.weightBps }))),
      );
      if (e2) throw e2;
    }
    this.seeded = true;
  }
  private map(row: Row, allocs: Row[]): PortfolioTemplate {
    return {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      description: String(row.description ?? ""),
      active: Boolean(row.active),
      allocations: allocs
        .filter((a) => a.template_id === row.id)
        .map((a) => ({ assetAddress: a.asset_address_or_usdc as PortfolioTemplate["allocations"][number]["assetAddress"], weightBps: Number(a.weight_bps) })),
    };
  }
  async list(activeOnly = true) {
    await this.ensureSeeded();
    let q = sb().from("portfolio_templates").select("*").order("created_at", { ascending: true });
    if (activeOnly) q = q.eq("active", true);
    const [{ data: rows, error }, { data: allocs, error: e2 }] = await Promise.all([q, sb().from("portfolio_template_allocations").select("*")]);
    if (error) throw error;
    if (e2) throw e2;
    return (rows ?? []).map((r) => this.map(r as Row, (allocs ?? []) as Row[]));
  }
  async getBySlug(slug: string) {
    const all = await this.list(false);
    return all.find((t) => t.slug === slug) ?? null;
  }
}

class SupabaseGiftRepo implements GiftRepo {
  private toRow(g: Partial<GiftRecord>): Row {
    const r: Row = {};
    if (g.id !== undefined) r.id = g.id;
    if (g.kind !== undefined) r.kind = g.kind;
    if (g.sender !== undefined) r.sender = g.sender.toLowerCase();
    if (g.recipient !== undefined) r.recipient = g.recipient.toLowerCase();
    if (g.recipientBasename !== undefined) r.recipient_basename = g.recipientBasename;
    if (g.assetAddress !== undefined) r.asset_address = g.assetAddress.toLowerCase();
    if (g.rawAmount !== undefined) r.raw_amount = g.rawAmount;
    if (g.message !== undefined) r.message = g.message;
    if (g.memo !== undefined) r.memo = g.memo;
    if (g.txHash !== undefined) r.tx_hash = g.txHash;
    if (g.status !== undefined) r.status = g.status;
    if (g.createdAt !== undefined) r.created_at = new Date(g.createdAt).toISOString();
    return r;
  }
  private fromRow(r: Row): GiftRecord {
    return {
      id: String(r.id),
      kind: r.kind as GiftRecord["kind"],
      sender: r.sender as Address,
      recipient: r.recipient as Address,
      recipientBasename: (r.recipient_basename as string | null) ?? undefined,
      assetAddress: r.asset_address as Address,
      rawAmount: String(r.raw_amount),
      message: (r.message as string | null) ?? undefined,
      memo: r.memo as GiftRecord["memo"],
      txHash: (r.tx_hash as Hash | null) ?? undefined,
      status: r.status as GiftRecord["status"],
      createdAt: new Date(String(r.created_at)).getTime(),
    };
  }
  async create(g: GiftRecord) {
    const { error } = await sb().from("gifts").insert(this.toRow(g));
    if (error) throw error;
    return g;
  }
  async update(id: string, patch: Partial<GiftRecord>) {
    const { data, error } = await sb().from("gifts").update(this.toRow(patch)).eq("id", id).select("*").maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async listByOwner(owner: Address) {
    const o = owner.toLowerCase();
    const { data, error } = await sb().from("gifts").select("*").or(`sender.eq.${o},recipient.eq.${o}`).order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
  async get(id: string) {
    const { data, error } = await sb().from("gifts").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
}

class SupabaseExecutionRepo implements ExecutionRepo {
  private fromRows(e: Row, steps: Row[]): PortfolioExecution {
    return {
      id: String(e.id),
      owner: e.wallet_address as Address,
      status: e.status as PortfolioExecution["status"],
      totalUsd: Number(e.total_usd),
      createdAt: new Date(String(e.created_at)).getTime(),
      updatedAt: new Date(String(e.updated_at)).getTime(),
      steps: steps
        .filter((s) => s.execution_id === e.id)
        .map((s) => ({
          id: String(s.id),
          assetAddress: s.asset_address as Address,
          symbol: String(s.symbol ?? ""),
          side: (s.side as "buy" | "sell" | null) ?? "buy",
          targetUsd: Number(s.target_usd),
          sellAmountUsdc: String(s.sell_amount_usdc),
          sellAmount: (s.sell_amount as string | null) ?? undefined,
          provider: (s.provider as string | null) ?? undefined,
          status: s.status as PortfolioExecutionStep["status"],
          txHash: (s.tx_hash as Hash | null) ?? undefined,
          errorCode: (s.error_code as string | null) ?? undefined,
          errorMessage: (s.error_message as string | null) ?? undefined,
        })),
    };
  }
  private stepRow(executionId: string, s: PortfolioExecutionStep): Row {
    return {
      id: s.id,
      execution_id: executionId,
      asset_address: s.assetAddress.toLowerCase(),
      symbol: s.symbol,
      side: s.side ?? "buy",
      target_usd: s.targetUsd,
      sell_amount_usdc: s.sellAmountUsdc,
      sell_amount: s.sellAmount ?? null,
      provider: s.provider ?? null,
      status: s.status,
      tx_hash: s.txHash ?? null,
      error_code: s.errorCode ?? null,
      error_message: s.errorMessage ?? null,
    };
  }
  async create(e: PortfolioExecution) {
    const { error } = await sb().from("portfolio_executions").insert({
      id: e.id,
      wallet_address: e.owner.toLowerCase(),
      status: e.status,
      total_usd: e.totalUsd,
      created_at: new Date(e.createdAt).toISOString(),
      updated_at: new Date(e.updatedAt).toISOString(),
    });
    if (error) throw error;
    if (e.steps.length) {
      const { error: e2 } = await sb().from("portfolio_execution_steps").insert(e.steps.map((s) => this.stepRow(e.id, s)));
      if (e2) throw e2;
    }
    return e;
  }
  async update(id: string, patch: Partial<Pick<PortfolioExecution, "status" | "updatedAt">> & { steps?: PortfolioExecutionStep[] }) {
    const row: Row = { updated_at: new Date(patch.updatedAt ?? Date.now()).toISOString() };
    if (patch.status) row.status = patch.status;
    const { error } = await sb().from("portfolio_executions").update(row).eq("id", id);
    if (error) throw error;
    if (patch.steps?.length) {
      const { error: e2 } = await sb().from("portfolio_execution_steps").upsert(patch.steps.map((s) => this.stepRow(id, s)));
      if (e2) throw e2;
    }
    return this.get(id);
  }
  async get(id: string) {
    const [{ data: e, error }, { data: steps, error: e2 }] = await Promise.all([
      sb().from("portfolio_executions").select("*").eq("id", id).maybeSingle(),
      sb().from("portfolio_execution_steps").select("*").eq("execution_id", id),
    ]);
    if (error) throw error;
    if (e2) throw e2;
    return e ? this.fromRows(e as Row, (steps ?? []) as Row[]) : null;
  }
  async listByOwner(owner: Address) {
    const { data: rows, error } = await sb().from("portfolio_executions").select("*").eq("wallet_address", owner.toLowerCase()).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    const ids = (rows ?? []).map((r) => (r as Row).id as string);
    if (ids.length === 0) return [];
    const { data: steps, error: e2 } = await sb().from("portfolio_execution_steps").select("*").in("execution_id", ids);
    if (e2) throw e2;
    return (rows ?? []).map((r) => this.fromRows(r as Row, (steps ?? []) as Row[]));
  }
}

class SupabaseTradeRepo implements TradeRepo {
  private toRow(t: Partial<TradeRecord>): Row {
    const r: Row = {};
    if (t.id !== undefined) r.id = t.id;
    if (t.owner !== undefined) r.wallet_address = t.owner.toLowerCase();
    if (t.side !== undefined) r.side = t.side;
    if (t.assetAddress !== undefined) r.asset_address = t.assetAddress.toLowerCase();
    if (t.sellAmount !== undefined) r.sell_amount = t.sellAmount;
    if (t.buyAmount !== undefined) r.buy_amount = t.buyAmount;
    if (t.usdValue !== undefined) r.usd_value = t.usdValue;
    if (t.provider !== undefined) r.provider = t.provider;
    if (t.txHash !== undefined) r.tx_hash = t.txHash;
    if (t.status !== undefined) r.status = t.status;
    if (t.recipient !== undefined) r.recipient = t.recipient?.toLowerCase();
    if (t.createdAt !== undefined) r.created_at = new Date(t.createdAt).toISOString();
    return r;
  }
  private fromRow(r: Row): TradeRecord {
    return {
      id: String(r.id),
      owner: r.wallet_address as Address,
      side: r.side as TradeRecord["side"],
      assetAddress: r.asset_address as Address,
      sellAmount: String(r.sell_amount),
      buyAmount: String(r.buy_amount),
      usdValue: r.usd_value === null || r.usd_value === undefined ? null : Number(r.usd_value),
      provider: String(r.provider),
      txHash: (r.tx_hash as Hash | null) ?? undefined,
      status: r.status as TradeRecord["status"],
      recipient: (r.recipient as Address | null) ?? undefined,
      createdAt: new Date(String(r.created_at)).getTime(),
    };
  }
  async create(t: TradeRecord) {
    const { error } = await sb().from("trade_records").insert(this.toRow(t));
    if (error) throw error;
    return t;
  }
  async update(id: string, patch: Partial<TradeRecord>) {
    const { data, error } = await sb().from("trade_records").update(this.toRow(patch)).eq("id", id).select("*").maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async listByOwner(owner: Address) {
    const { data, error } = await sb().from("trade_records").select("*").eq("wallet_address", owner.toLowerCase()).order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
  async listSince(sinceMs: number, limit = 2000) {
    const { data, error } = await sb().from("trade_records").select("*").not("tx_hash", "is", null).gte("created_at", new Date(sinceMs).toISOString()).order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
}

class SupabaseEarnActionRepo implements EarnActionRepo {
  private fromRow(r: Row): EarnActionRecord {
    return {
      id: String(r.id),
      owner: r.wallet_address as Address,
      opportunityId: String(r.opportunity_id),
      provider: String(r.provider),
      action: r.action as EarnActionRecord["action"],
      amount: String(r.amount),
      usdValue: r.usd_value === null || r.usd_value === undefined ? null : Number(r.usd_value),
      txHash: (r.tx_hash as Hash | null) ?? undefined,
      createdAt: new Date(String(r.created_at)).getTime(),
    };
  }
  async create(a: EarnActionRecord) {
    const { error } = await sb()
      .from("earn_actions")
      .insert({ id: a.id, wallet_address: a.owner.toLowerCase(), opportunity_id: a.opportunityId, provider: a.provider, action: a.action, amount: a.amount, usd_value: a.usdValue, tx_hash: a.txHash ?? null, created_at: new Date(a.createdAt).toISOString() });
    if (error) throw error;
    return a;
  }
  async listByOwner(owner: Address) {
    const { data, error } = await sb().from("earn_actions").select("*").eq("wallet_address", owner.toLowerCase()).order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    return (data ?? []).map((r) => this.fromRow(r as Row));
  }
}

class SupabaseDigestRepo implements DigestRepo {
  private fromRow(r: Row): DigestRecord {
    return {
      key: String(r.key),
      kind: r.kind as DigestRecord["kind"],
      owner: (r.owner as Address | null) ?? null,
      content: r.content as DigestRecord["content"],
      model: String(r.model),
      costUsd: Number(r.cost_usd ?? 0),
      createdAt: new Date(String(r.created_at)).getTime(),
      expiresAt: new Date(String(r.expires_at)).getTime(),
    };
  }
  async get(key: string) {
    const { data, error } = await sb().from("ai_digests").select("*").eq("key", key).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
  async put(r: DigestRecord) {
    const { error } = await sb().from("ai_digests").upsert({ key: r.key, kind: r.kind, owner: r.owner ? r.owner.toLowerCase() : null, content: r.content, model: r.model, cost_usd: r.costUsd, created_at: new Date(r.createdAt).toISOString(), expires_at: new Date(r.expiresAt).toISOString() });
    if (error) throw error;
  }
  async latest(kind: DigestRecord["kind"], owner?: Address) {
    let q = sb().from("ai_digests").select("*").eq("kind", kind);
    if (owner) q = q.eq("owner", owner.toLowerCase());
    const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? this.fromRow(data as Row) : null;
  }
}

class SupabaseWatchlistRepo implements WatchlistRepo {
  async list(owner: Address) {
    const { data, error } = await sb().from("watchlists").select("asset_address").eq("wallet_address", owner.toLowerCase());
    if (error) throw error;
    return (data ?? []).map((r) => (r as Row).asset_address as Address);
  }
  async add(owner: Address, asset: Address) {
    const { error } = await sb().from("watchlists").upsert({ wallet_address: owner.toLowerCase(), asset_address: asset.toLowerCase() }, { onConflict: "wallet_address,asset_address" });
    if (error) throw error;
  }
  async remove(owner: Address, asset: Address) {
    const { error } = await sb().from("watchlists").delete().eq("wallet_address", owner.toLowerCase()).eq("asset_address", asset.toLowerCase());
    if (error) throw error;
  }
}

class SupabaseDiscoveredAssetRepo implements DiscoveredAssetRepo {
  async upsert(items: DiscoveredAsset[]) {
    if (items.length === 0) return;
    const { error } = await sb()
      .from("discovered_assets")
      .upsert(
        items.map((d) => ({
          address: d.address.toLowerCase(),
          name: d.name,
          symbol: d.symbol,
          block_number: d.blockNumber,
          underlying: d.underlying ?? null,
          chainlink_feed: d.chainlinkFeed ?? null,
          tags: d.tags ?? [],
          eligible: d.eligible ?? false,
          auto_verified: d.autoVerified ?? false,
          creator: d.creator ?? null,
          reason: d.reason ?? null,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "address", ignoreDuplicates: false },
      );
    if (error) throw error;
  }
  async list() {
    const { data, error } = await sb().from("discovered_assets").select("*").order("block_number", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((r) => {
      const row = r as Row;
      return {
        address: row.address as Address,
        name: String(row.name ?? ""),
        symbol: String(row.symbol ?? ""),
        blockNumber: Number(row.block_number ?? 0),
        verification: (row.verification as DiscoveredAsset["verification"]) ?? "discovered",
        updatedAt: new Date(String(row.updated_at)).getTime(),
        underlying: (row.underlying as string | null) ?? undefined,
        chainlinkFeed: (row.chainlink_feed as Address | null) ?? undefined,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        eligible: Boolean(row.eligible),
        autoVerified: Boolean(row.auto_verified),
        creator: (row.creator as Address | null) ?? undefined,
        reason: (row.reason as string | null) ?? undefined,
      };
    });
  }
  async setVerification(address: Address, v: DiscoveredAsset["verification"]) {
    const { error } = await sb().from("discovered_assets").update({ verification: v, updated_at: new Date().toISOString() }).eq("address", address.toLowerCase());
    if (error) throw error;
  }
}

/* ------------------------------ Factory ------------------------------ */

let repos: Repos | null = null;

export function getRepos(): Repos {
  if (repos) return repos;
  if (getSupabaseAdmin()) {
    const memoryTemplates = new MemoryTemplateRepo();
    repos = {
      backend: "supabase",
      // Reads fall back to seeds/empty and writes are dropped (logged) when a table is missing.
      templates: resilient("templates", new SupabaseTemplateRepo(), { list: (activeOnly?: boolean) => memoryTemplates.list(activeOnly), getBySlug: (slug: string) => memoryTemplates.getBySlug(slug) }),
      gifts: resilient("gifts", new SupabaseGiftRepo(), { create: (g: GiftRecord) => g, update: null, listByOwner: [] }),
      executions: resilient("executions", new SupabaseExecutionRepo(), { create: (e: PortfolioExecution) => e, update: null, get: null, listByOwner: [] }),
      trades: resilient("trades", new SupabaseTradeRepo(), { create: (t: TradeRecord) => t, update: null, listByOwner: [], listSince: [] }),
      watchlists: resilient("watchlists", new SupabaseWatchlistRepo(), { list: [], add: undefined, remove: undefined }),
      discoveredAssets: resilient("discoveredAssets", new SupabaseDiscoveredAssetRepo(), { upsert: undefined, list: [], setVerification: undefined }),
      profiles: resilient("profiles", new SupabaseProfileRepo(), { get: null, getByHandle: null, upsert: (p: unknown) => p, touch: undefined }),
      baskets: resilient("baskets", new SupabaseBasketRepo(), { list: [], get: null, create: (b: unknown) => b, listByOwner: [], vote: { voted: false, votes: 0 }, hasVoted: false, incrementClones: undefined }),
      referrals: resilient("referrals", new SupabaseReferralRepo(), { claim: undefined, markFirstTrade: undefined, get: null, statsFor: { invited: 0, traded: 0 } }),
      snapshots: resilient("snapshots", new SupabaseSnapshotRepo(), { record: undefined, list: [] }),
      automation: resilient("automation", new SupabaseAutomationRepo(), { list: [], create: (r: unknown) => r, update: null, remove: undefined }),
      earnActions: resilient("earnActions", new SupabaseEarnActionRepo(), { create: (a: EarnActionRecord) => a, listByOwner: [] }),
      digests: resilient("digests", new SupabaseDigestRepo(), { get: null, put: undefined, latest: null }),
    };
  } else {
    metrics.count("db.memoryBackend");
    repos = {
      backend: "memory",
      templates: new MemoryTemplateRepo(),
      gifts: new MemoryGiftRepo(),
      executions: new MemoryExecutionRepo(),
      trades: new MemoryTradeRepo(),
      watchlists: new MemoryWatchlistRepo(),
      discoveredAssets: new MemoryDiscoveredAssetRepo(),
      profiles: new MemoryProfileRepo(),
      baskets: new MemoryBasketRepo(),
      referrals: new MemoryReferralRepo(),
      snapshots: new MemorySnapshotRepo(),
      automation: new MemoryAutomationRepo(),
      earnActions: new MemoryEarnActionRepo(),
      digests: new MemoryDigestRepo(),
    };
  }
  return repos;
}

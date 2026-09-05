import type { Address } from "viem";
import type { Badge, CommunityBasket, CommunityPulse, Profile } from "@/domain/community";
import type { Allocation } from "@/domain/portfolio";
import { getRepos } from "@/db/repositories";
import { getAssets } from "./b20-asset-service";
import { validateAllocations } from "./portfolio-service";
import { cached } from "@/lib/cache";
import { AppError } from "@/lib/errors";
import { newId } from "@/lib/execution/portfolio-execution";

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;

/* ------------------------------ Pulse ------------------------------ */

/** Anonymous 7-day aggregates from submitted app trades: most bought / most sold, active traders. */
export async function getCommunityPulse(): Promise<CommunityPulse> {
  return cached("community:pulse", { ttlMs: 60_000, staleMs: 10 * 60_000, shared: true }, async () => {
    const repos = getRepos();
    const since = Date.now() - 7 * 24 * 3600_000;
    const [trades, assets, topBaskets] = await Promise.all([repos.trades.listSince(since), getAssets(), repos.baskets.list({ sort: "votes", limit: 5 })]);
    const byAsset = new Map(assets.map((a) => [a.canonicalId, a]));
    const agg = new Map<string, { assetAddress: Address; symbol: string; trades: number; usd: number }>();
    const traders = new Set<string>();
    const bump = (side: "buy" | "sell", assetAddress: Address, usd: number | null) => {
      const key = `${side}:${assetAddress.toLowerCase()}`;
      const a = byAsset.get(assetAddress.toLowerCase());
      const cur = agg.get(key) ?? { assetAddress: a?.address ?? assetAddress, symbol: a?.underlying ?? assetAddress.slice(0, 6), trades: 0, usd: 0 };
      cur.trades += 1;
      cur.usd += usd ?? 0;
      agg.set(key, cur);
    };
    for (const t of trades) {
      traders.add(t.owner.toLowerCase());
      bump(t.side, t.assetAddress, t.usdValue);
    }
    const pick = (side: "buy" | "sell") =>
      [...agg.entries()]
        .filter(([k]) => k.startsWith(`${side}:`))
        .map(([, v]) => v)
        .sort((a, b) => b.trades - a.trades || b.usd - a.usd)
        .slice(0, 5);
    return { window: "7d", mostBought: pick("buy"), mostSold: pick("sell"), topBaskets, traders: traders.size, updatedAt: Date.now() };
  });
}

/* ------------------------------ Baskets ------------------------------ */

export async function publishBasket(owner: Address, input: { name: string; description?: string; allocations: Allocation[] }): Promise<CommunityBasket> {
  const name = input.name.replace(/[<>]/g, "").trim().slice(0, 48);
  const description = (input.description ?? "").replace(/[<>]/g, "").trim().slice(0, 280);
  if (name.length < 3) throw new AppError("BAD_REQUEST", "Give the basket a name (3+ characters).", 400);
  const assets = await getAssets();
  const v = validateAllocations(input.allocations, { allowedAssets: new Set(assets.filter((a) => a.status === "active").map((a) => a.canonicalId)) });
  if (!v.ok) throw new AppError("BAD_REQUEST", v.errors.join(" "), 400, { errors: v.errors });
  const mine = await getRepos().baskets.listByOwner(owner);
  if (mine.length >= 20) throw new AppError("BAD_REQUEST", "You already published 20 baskets. Remove one first.", 400);
  const basket: CommunityBasket = { id: newId("bk"), owner, name, description, allocations: v.normalized, clones: 0, votes: 0, createdAt: Date.now(), updatedAt: Date.now() };
  return getRepos().baskets.create(basket);
}

export async function listBaskets(sort: "votes" | "new", limit = 30): Promise<CommunityBasket[]> {
  return getRepos().baskets.list({ sort, limit });
}

/* ------------------------------ Profiles ------------------------------ */

export async function updateProfile(address: Address, patch: { handle?: string; displayName?: string; bio?: string; isPublic?: boolean }): Promise<Profile> {
  const repos = getRepos();
  const cur = (await repos.profiles.get(address)) ?? { address, isPublic: true, createdAt: Date.now(), updatedAt: Date.now() };
  let handle = cur.handle;
  if (patch.handle !== undefined) {
    const h = patch.handle.trim().toLowerCase();
    if (h && !HANDLE_RE.test(h)) throw new AppError("BAD_REQUEST", "Handle: 3–24 characters, letters, numbers, _ or -.", 400);
    if (h) {
      const taken = await repos.profiles.getByHandle(h);
      if (taken && taken.address.toLowerCase() !== address.toLowerCase()) throw new AppError("BAD_REQUEST", "That handle is taken.", 400);
    }
    handle = h || undefined;
  }
  const next: Profile = {
    ...cur,
    handle,
    displayName: patch.displayName !== undefined ? patch.displayName.replace(/[<>]/g, "").trim().slice(0, 40) || undefined : cur.displayName,
    bio: patch.bio !== undefined ? patch.bio.replace(/[<>]/g, "").trim().slice(0, 200) || undefined : cur.bio,
    isPublic: patch.isPublic ?? cur.isPublic,
    updatedAt: Date.now(),
  };
  return repos.profiles.upsert(next);
}

/** Resolve `/u/<handle-or-address>` to an address. */
export async function resolveProfileRef(ref: string): Promise<Address | null> {
  if (/^0x[0-9a-fA-F]{40}$/.test(ref)) return ref as Address;
  const p = await getRepos().profiles.getByHandle(ref.toLowerCase());
  return p?.address ?? null;
}

/* ------------------------------ Badges ------------------------------ */

export async function computeBadges(address: Address): Promise<Badge[]> {
  const repos = getRepos();
  const [trades, gifts, executions, baskets] = await Promise.all([
    repos.trades.listByOwner(address),
    repos.gifts.listByOwner(address),
    repos.executions.listByOwner(address),
    repos.baskets.listByOwner(address),
  ]);
  const submittedTrades = trades.filter((t) => t.txHash);
  const distinct = new Set(submittedTrades.filter((t) => t.side === "buy").map((t) => t.assetAddress.toLowerCase()));
  const firstTrade = submittedTrades.length ? Math.min(...submittedTrades.map((t) => t.createdAt)) : undefined;
  const sentGift = gifts.find((g) => g.sender.toLowerCase() === address.toLowerCase() && g.txHash);
  const builtBasket = executions.find((e) => e.steps.some((s) => s.status === "confirmed"));
  const confirmedBuilds = executions.filter((e) => e.steps.some((s) => s.status === "confirmed")).length;
  const sentGifts = gifts.filter((g) => g.sender.toLowerCase() === address.toLowerCase() && g.txHash).length;
  const topVotes = baskets.reduce((m, b) => Math.max(m, b.votes), 0);
  const step = (current: number, target: number) => ({ current: Math.min(current, target), target });
  return [
    { id: "first-trade", label: "First trade", description: "Completed a first buy or sell on Base.", earned: submittedTrades.length > 0, earnedAt: firstTrade, progress: step(submittedTrades.length, 1) },
    { id: "diversified", label: "Diversified", description: "Holds 5 or more different tokenized stocks bought here.", earned: distinct.size >= 5, progress: step(distinct.size, 5) },
    { id: "builder", label: "Basket builder", description: "Executed a multi-stock basket.", earned: !!builtBasket, earnedAt: builtBasket?.createdAt, progress: step(confirmedBuilds, 1) },
    { id: "gifter", label: "Gifter", description: "Sent stock to another wallet or Basename.", earned: !!sentGift, earnedAt: sentGift?.createdAt, progress: step(sentGifts, 1) },
    { id: "curator", label: "Curator", description: "Published a community basket.", earned: baskets.length > 0, earnedAt: baskets[0]?.createdAt, progress: step(baskets.length, 1) },
    { id: "popular", label: "Popular curator", description: "A published basket reached 10 votes.", earned: baskets.some((b) => b.votes >= 10), progress: step(topVotes, 10) },
  ];
}

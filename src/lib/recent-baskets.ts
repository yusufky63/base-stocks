import type { Allocation } from "@/domain/portfolio";

/**
 * Baskets kept on this device: the one being edited (restored on the next visit) and the last few
 * that were drafted, bought, published or handed to Automate. Pure functions here; the hook wires
 * them to localStorage. Nothing leaves the browser — published baskets are a separate, explicit act.
 */
export type SavedBasketSource = "template" | "custom" | "ai";

export interface SavedBasket {
  id: string;
  name: string;
  allocations: Allocation[];
  source: SavedBasketSource;
  /** Unix ms. */
  savedAt: number;
}

export interface BasketStore {
  draft: SavedBasket | null;
  recent: SavedBasket[];
}

export const MAX_RECENT = 12;
export const EMPTY_STORE: BasketStore = { draft: null, recent: [] };

/** The same stocks at the same weights are the same basket, whatever it was called. */
export function basketSignature(allocations: Allocation[]): string {
  return allocations
    .map((a) => `${String(a.assetAddress).toLowerCase()}:${a.weightBps}`)
    .sort()
    .join("|");
}

/** Newest first, one entry per distinct mix (a repeat moves to the top and takes the new name), capped. */
export function remember(list: SavedBasket[], basket: { name: string; allocations: Allocation[]; source: SavedBasketSource }, now = Date.now()): SavedBasket[] {
  if (basket.allocations.length === 0) return list;
  const sig = basketSignature(basket.allocations);
  const rest = list.filter((b) => basketSignature(b.allocations) !== sig);
  const entry: SavedBasket = { id: `basket_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name: basket.name, allocations: basket.allocations, source: basket.source, savedAt: now };
  return [entry, ...rest].slice(0, MAX_RECENT);
}

const SOURCES: SavedBasketSource[] = ["template", "custom", "ai"];

function isBasket(x: unknown): x is SavedBasket {
  if (!x || typeof x !== "object") return false;
  const b = x as Partial<SavedBasket>;
  return typeof b.id === "string" && typeof b.name === "string" && Array.isArray(b.allocations) && b.allocations.every((a) => a && typeof a.assetAddress === "string" && typeof a.weightBps === "number") && SOURCES.includes(b.source as SavedBasketSource) && typeof b.savedAt === "number";
}

/** Whatever is on disk, read defensively: a bad entry is dropped, a bad blob is an empty store. */
export function parseStore(raw: string | null): BasketStore {
  if (!raw) return EMPTY_STORE;
  try {
    const parsed = JSON.parse(raw) as Partial<BasketStore>;
    const recent = Array.isArray(parsed.recent) ? parsed.recent.filter(isBasket).slice(0, MAX_RECENT) : [];
    const draft = isBasket(parsed.draft) && parsed.draft.allocations.length > 0 ? parsed.draft : null;
    return { draft, recent };
  } catch {
    return EMPTY_STORE;
  }
}

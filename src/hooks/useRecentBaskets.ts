"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Allocation } from "@/domain/portfolio";
import { EMPTY_STORE, parseStore, remember, type BasketStore, type SavedBasket, type SavedBasketSource } from "@/lib/recent-baskets";

/**
 * Baskets kept on this device (localStorage): the draft in the editor and the last few that were
 * drafted, bought, published or sent to Automate. Read through useSyncExternalStore so a change in
 * one tab shows in the others, and so the server render never sees a value it cannot know.
 */
const KEY = "bstocks.baskets.v1";
const EVENT = "bstocks:baskets";

let cachedRaw: string | null | undefined;
let cachedStore: BasketStore = EMPTY_STORE;

function read(): BasketStore {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedStore = parseStore(raw);
  }
  return cachedStore;
}

function write(next: BasketStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode or a full store: the session still works, nothing is kept */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function useRecentBaskets() {
  const store = useSyncExternalStore(subscribe, read, () => EMPTY_STORE);
  const saveDraft = useCallback((draft: SavedBasket | null) => write({ ...read(), draft }), []);
  const rememberBasket = useCallback((basket: { name: string; allocations: Allocation[]; source: SavedBasketSource }) => write({ ...read(), recent: remember(read().recent, basket) }), []);
  const forget = useCallback((id: string) => write({ ...read(), recent: read().recent.filter((b) => b.id !== id) }), []);
  return { draft: store.draft, recent: store.recent, saveDraft, rememberBasket, forget };
}

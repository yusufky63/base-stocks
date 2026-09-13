"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

export interface StockParams {
  /** `?trade=buy|sell` opens the trade sheet on that side. */
  trade: string | null;
  /** `?tab=position|trades|orders|earn|details` selects the section. */
  tab: string | null;
}

/**
 * Reads the stock page's URL hints (`?trade=`, `?tab=`).
 *
 * `useSearchParams` makes everything up to the nearest Suspense boundary render on the client,
 * and the stock view called it at its root: the server sent a 480 px skeleton where the price and
 * the chart should have been, on every visit. Kept in a leaf of its own, inside its own boundary,
 * the hints cost the page nothing and the rest prerenders.
 */
export function TradeParam({ onChange }: { onChange: (value: StockParams) => void }) {
  const params = useSearchParams();
  const trade = params.get("trade");
  const tab = params.get("tab");
  useEffect(() => {
    onChange({ trade, tab });
  }, [trade, tab, onChange]);
  return null;
}

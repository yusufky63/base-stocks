"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { apiPost, ApiError, type TradeQuoteSummary } from "@/lib/client-api";
import type { TradeSide } from "@/domain/trade";
import { BASE_CHAIN_ID } from "@/config/chain";

export interface TradePriceInput {
  side: TradeSide;
  payWith?: "USDC" | "ETH";
  assetAddress: Address;
  sellAmount: bigint;
  taker?: Address;
  recipient?: Address;
  slippageBps?: number;
}

export interface TradePriceState {
  status: "idle" | "loading" | "ready" | "error";
  summary: TradeQuoteSummary | null;
  error: { code: string; message: string } | null;
  refresh: () => void;
}

interface Loaded {
  key: string;
  summary: TradeQuoteSummary | null;
  error: TradePriceState["error"];
}

/** Debounced indicative price with periodic refresh while the sheet is open. */
export function useTradePrice(input: TradePriceInput | null, opts?: { debounceMs?: number; refreshMs?: number }): TradePriceState {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  const active = !!input && input.sellAmount > 0n;
  const key = active ? `${input.side}:${input.payWith ?? "USDC"}:${input.assetAddress}:${input.sellAmount.toString()}:${input.taker ?? ""}:${input.recipient ?? ""}:${input.slippageBps ?? ""}` : "";

  useEffect(() => {
    if (!active || !input) return;
    const mySeq = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const s = await apiPost<TradeQuoteSummary>("/api/trade/price", {
          side: input.side,
          assetAddress: input.assetAddress,
          sellAmount: input.sellAmount.toString(), payWith: input.payWith,
          taker: input.taker,
          recipient: input.recipient,
          slippageBps: input.slippageBps,
          chainId: BASE_CHAIN_ID,
        });
        if (mySeq !== seq.current) return;
        setLoaded({ key, summary: s, error: null });
      } catch (err) {
        if (mySeq !== seq.current) return;
        setLoaded({ key, summary: null, error: err instanceof ApiError ? { code: err.code, message: err.message } : { code: "UNKNOWN", message: "Price unavailable right now." } });
      }
    }, opts?.debounceMs ?? 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, active]);

  const ready = active && loaded?.key === key;
  const status: TradePriceState["status"] = !active ? "idle" : !ready ? "loading" : loaded?.error ? "error" : "ready";

  useEffect(() => {
    if (status !== "ready") return;
    const t = setInterval(() => setTick((x) => x + 1), opts?.refreshMs ?? 12_000);
    return () => clearInterval(t);
  }, [status, opts?.refreshMs]);

  // While a new amount is loading, keep showing the previous summary (dimmed by the UI) to avoid flicker.
  const summary = !active ? null : ready ? loaded!.summary : (loaded?.summary ?? null);
  const error = ready ? (loaded?.error ?? null) : null;

  return { status, summary, error, refresh: () => setTick((x) => x + 1) };
}

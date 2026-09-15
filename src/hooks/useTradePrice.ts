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
  /** Prefer CoW's batch auction when it is competitive; the answer's `execution` says what happened. */
  bestExecution?: boolean;
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

/**
 * How long typing has to pause before the providers are asked. At 350 ms a hand typing "1250"
 * fired a comparison on "12" and again on "125", seven provider calls each, for numbers nobody
 * meant; 600 ms is still well inside what feels immediate once the typing stops.
 */
const DEBOUNCE_MS = 600;

/** Debounced indicative price with periodic refresh while the sheet is open. */
export function useTradePrice(input: TradePriceInput | null, opts?: { debounceMs?: number; refreshMs?: number }): TradePriceState {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  const active = !!input && input.sellAmount > 0n;
  const key = active ? `${input.side}:${input.payWith ?? "USDC"}:${input.assetAddress}:${input.sellAmount.toString()}:${input.taker ?? ""}:${input.recipient ?? ""}:${input.slippageBps ?? ""}:${input.bestExecution ? 1 : 0}` : "";

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
          bestExecution: input.bestExecution || undefined,
          chainId: BASE_CHAIN_ID,
        });
        if (mySeq !== seq.current) return;
        setLoaded({ key, summary: s, error: null });
      } catch (err) {
        if (mySeq !== seq.current) return;
        setLoaded({ key, summary: null, error: err instanceof ApiError ? { code: err.code, message: err.message } : { code: "UNKNOWN", message: "Price unavailable right now." } });
      }
    }, opts?.debounceMs ?? DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, active]);

  const ready = active && loaded?.key === key;
  const status: TradePriceState["status"] = !active ? "idle" : !ready ? "loading" : loaded?.error ? "error" : "ready";

  // Refresh only while the tab is visible: a sheet left open in a background tab used to ask
  // seven providers for a price every twelve seconds for nobody.
  useEffect(() => {
    if (status !== "ready") return;
    const every = opts?.refreshMs ?? 12_000;
    let t: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (t === null && !document.hidden) t = setInterval(() => setTick((x) => x + 1), every);
    };
    const stop = () => {
      if (t !== null) clearInterval(t);
      t = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        setTick((x) => x + 1);
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, opts?.refreshMs]);

  // While a new amount is loading, keep showing the previous summary (dimmed by the UI) to avoid flicker.
  const summary = !active ? null : ready ? loaded!.summary : (loaded?.summary ?? null);
  const error = ready ? (loaded?.error ?? null) : null;

  return { status, summary, error, refresh: () => setTick((x) => x + 1) };
}

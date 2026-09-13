import type { Address, Hex } from "viem";
import { serverEnv } from "@/config/env";
import { integratorFee } from "@/lib/fees";
import { BASE_CHAIN_ID, EXECUTABLE_QUOTE_TTL_MS, USDC_ADDRESS } from "@/config/chain";
import { CURATED_B20_ASSETS } from "@/lib/b20/registry";
import type { ExecutableQuote, IndicativeQuote, TradeIntent, TradeProvider } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";
import { INDICATIVE_TIMEOUT_MS } from "../budget";
import { zeroXErrorSchema, zeroXPriceSchema, zeroXQuoteSchema } from "./schemas";

/**
 * 0x Swap API v2 — AllowanceHolder flow.
 * Docs: https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getprice
 *       https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getquote
 * The API key never leaves the server.
 */
const BASE_URL = "https://api.0x.org";
const breaker = new CircuitBreaker("zeroX", 3, 20_000);

/**
 * AllowanceHolder on Base (a Cancun chain). In the allowance-holder flow it is both the contract
 * the wallet approves (`issues.allowance.spender`) and the transaction's `to`: the wallet calls
 * AllowanceHolder, which pulls the tokens and forwards to the Settler of the day. The Settler
 * address rotates with releases and never appears as the target, so this one address is the whole
 * allowlist. From 0x's allowance-holder example (0x-examples, read 2026-09-13): "ONLY set
 * allowances on Permit2 or AllowanceHolder contracts, as indicated by the API response".
 */
export const ZEROX_ALLOWANCE_HOLDER: Address = "0x0000000000001fF3684f28c67538d4D072C22734";
/** Contracts a 0x quote may send the wallet to or ask it to approve. */
export const EXPECTED_TARGETS: readonly Address[] = [ZEROX_ALLOWANCE_HOLDER];

/**
 * 0x refuses some tokens for legal reasons (`*_TOKEN_NOT_AUTHORIZED_FOR_TRADE`, HTTP 422).
 * Remember those per asset so the router skips 0x instantly instead of paying a failed call
 * (and tripping the circuit breaker) on every quote. Re-checked after the TTL.
 */
const UNAUTHORIZED_TTL_MS = 60 * 60_000;
/**
 * Process-global state: the instrumentation warm-up and the route handlers are separate bundles in
 * Next.js, each with its own module instance, so a module-level Map would not be shared between them.
 */
interface ZeroXState {
  assets: Map<string, number>;
  /** The refusal is a token-class policy ("tokenized stocks blocked until the integrator opts in"), so one 422 marks every curated stock. */
  classRefusal: { since: number; until: number; sample: string } | null;
}
const g = globalThis as unknown as { __bstocksZeroX?: ZeroXState };
const state: ZeroXState = (g.__bstocksZeroX ??= { assets: new Map(), classRefusal: null });

function markUnauthorized(sample: string) {
  const now = Date.now();
  const until = now + UNAUTHORIZED_TTL_MS;
  for (const e of CURATED_B20_ASSETS) state.assets.set(e.address.toLowerCase(), until);
  state.classRefusal = { since: state.classRefusal?.since ?? now, until, sample };
}

function isUnauthorized(intent: TradeIntent): boolean {
  const until = state.assets.get(intent.assetAddress.toLowerCase());
  if (until === undefined) return false;
  if (Date.now() > until) {
    state.assets.delete(intent.assetAddress.toLowerCase());
    return false;
  }
  return true;
}

export function zeroXUnauthorizedAssets(): string[] {
  const now = Date.now();
  return [...state.assets.entries()].filter(([, until]) => until > now).map(([a]) => a);
}

export interface ZeroXStatus {
  configured: boolean;
  /** True while 0x refuses tokenized stocks for this API key (needs 0x's tokenized-equities opt-in). */
  refusesTokenizedStocks: boolean;
  since: number | null;
  retryAt: number | null;
  lastError: string | null;
}

export function zeroXStatus(): ZeroXStatus {
  const active = state.classRefusal !== null && state.classRefusal.until > Date.now();
  return { configured: ZeroXTradeProvider.isConfigured(), refusesTokenizedStocks: active, since: active ? state.classRefusal!.since : null, retryAt: active ? state.classRefusal!.until : null, lastError: state.classRefusal?.sample ?? null };
}

/**
 * Boot-time probe (called from instrumentation): one indicative price for the first curated stock.
 * Learns the opt-in status once instead of paying a 422 per asset on first use, and keeps the
 * Settings diagnostics honest. Never throws.
 */
export async function probeZeroXTokenizedStocks(): Promise<ZeroXStatus> {
  if (!ZeroXTradeProvider.isConfigured()) return zeroXStatus();
  const sample = CURATED_B20_ASSETS[0];
  if (!sample) return zeroXStatus();
  const params = new URLSearchParams({ chainId: String(BASE_CHAIN_ID), sellToken: USDC_ADDRESS, buyToken: sample.address, sellAmount: "1000000", slippageBps: "100" });
  try {
    const result = await call("/swap/allowance-holder/price", params, 6_000);
    if (result === UNAUTHORIZED) markUnauthorized(`${sample.underlying}: not authorized for trade (0x legal restrictions)`);
    else state.classRefusal = null;
  } catch (err) {
    metrics.count("zeroX.probe", false, err instanceof Error ? err.message : String(err));
  }
  return zeroXStatus();
}

function toBig(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function buildParams(intent: TradeIntent, firm: boolean): URLSearchParams {
  const p = new URLSearchParams({
    chainId: String(intent.chainId),
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: intent.sellAmount.toString(),
    slippageBps: String(intent.slippageBps),
  });
  if (intent.taker) p.set("taker", intent.taker);
  if (firm && intent.recipient && intent.recipient.toLowerCase() !== intent.taker?.toLowerCase()) {
    p.set("recipient", intent.recipient);
  }
  const fee = integratorFee();
  if (fee) {
    p.set("swapFeeBps", String(fee.bps));
    p.set("swapFeeRecipient", fee.recipient);
    p.set("swapFeeToken", intent.sellToken);
  }
  return p;
}

const UNAUTHORIZED = Symbol("zeroX-unauthorized");

async function call(path: string, params: URLSearchParams, timeoutMs: number): Promise<unknown | typeof UNAUTHORIZED> {
  const env = serverEnv();
  if (!env.ZEROX_API_KEY) throw new AppError("PROVIDER_UNAVAILABLE", "zeroX: not configured", 503);
  const { status, data } = await fetchJson<unknown>(`${BASE_URL}${path}?${params.toString()}`, {
    headers: { "0x-api-key": env.ZEROX_API_KEY!, "0x-version": "v2" },
    timeoutMs,
    provider: "zeroX",
  });
  if (status >= 400) {
    const err = zeroXErrorSchema.safeParse(data);
    const name = err.success ? (err.data.name ?? "") : "";
    const msg = err.success ? `${name} ${err.data.message ?? ""}`.trim() : `http ${status}`;
    // Legal/compliance refusal for this asset: not an outage, must not trip the breaker.
    if (status === 422 && /TOKEN_NOT_AUTHORIZED_FOR_TRADE/.test(name)) return UNAUTHORIZED;
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", `zeroX: rate limited`, 503);
    if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `zeroX: ${msg}`, 502);
    // Other 4xx from 0x: validation (bad amount/token/taker). Not a provider outage.
    throw new AppError("ROUTE_UNAVAILABLE", `zeroX: ${msg}`, 400);
  }
  return data;
}

/** Skips 0x instantly for assets it refused recently; otherwise calls through the circuit breaker. */
async function guarded(path: string, params: URLSearchParams, timeoutMs: number, intent: TradeIntent): Promise<unknown> {
  if (isUnauthorized(intent)) throw new AppError("PROVIDER_UNAVAILABLE", "zeroX: asset not authorized for trade on 0x", 503);
  const result = await breaker.run(() => call(path, params, timeoutMs));
  if (result === UNAUTHORIZED) {
    markUnauthorized(`${intent.assetAddress}: not authorized for trade (0x legal restrictions)`);
    metrics.count("zeroX.unauthorizedAsset", false, intent.assetAddress);
    throw new AppError("PROVIDER_UNAVAILABLE", "zeroX: tokenized stocks are not enabled for this 0x API key (legal restrictions)", 503);
  }
  return result;
}

function normalizeIndicative(raw: unknown, intent: TradeIntent): IndicativeQuote {
  const parsed = zeroXPriceSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "zeroX: unexpected response schema", 502);
  const d = parsed.data;
  const allowance = d.issues?.allowance ?? null;
  const balance = d.issues?.balance ?? null;
  return {
    provider: "zeroX",
    sellToken: intent.sellToken,
    buyToken: intent.buyToken,
    sellAmount: toBig(d.sellAmount) ?? intent.sellAmount,
    buyAmount: toBig(d.buyAmount) ?? 0n,
    minBuyAmount: toBig(d.minBuyAmount),
    gas: toBig(d.gas),
    gasPrice: toBig(d.gasPrice),
    totalNetworkFeeWei: toBig(d.totalNetworkFee),
    liquidityAvailable: d.liquidityAvailable,
    allowanceTarget: (d.allowanceTarget as Address | null | undefined) ?? (allowance?.spender as Address | undefined) ?? null,
    route: (d.route?.fills ?? []).map((f) => ({
      source: f.source,
      proportionBps: f.proportionBps === null || f.proportionBps === undefined ? null : Number(f.proportionBps),
    })),
    issues: {
      allowanceRequired: allowance !== null && allowance !== undefined,
      allowanceSpender: (allowance?.spender as Address | undefined) ?? null,
      balanceInsufficient: balance !== null && balance !== undefined,
      simulationIncomplete: d.issues?.simulationIncomplete ?? false,
    },
    fetchedAt: Date.now(),
    integratorFeeBps: integratorFee()?.bps,
  };
}

export class ZeroXTradeProvider implements TradeProvider {
  readonly id = "zeroX" as const;

  static isConfigured(): boolean {
    return !!serverEnv().ZEROX_API_KEY;
  }

  async getIndicativeQuote(intent: TradeIntent): Promise<IndicativeQuote> {
    const raw = await guarded("/swap/allowance-holder/price", buildParams(intent, false), INDICATIVE_TIMEOUT_MS, intent);
    const q = normalizeIndicative(raw, intent);
    if (!q.liquidityAvailable) throw new AppError("ROUTE_UNAVAILABLE", "zeroX: no liquidity for this amount", 409);
    return q;
  }

  async getExecutableQuote(intent: TradeIntent): Promise<ExecutableQuote> {
    if (!intent.taker) throw new AppError("BAD_REQUEST", "taker is required for an executable quote", 400);
    const raw = await guarded("/swap/allowance-holder/quote", buildParams(intent, true), 7_000, intent);
    const parsed = zeroXQuoteSchema.safeParse(raw);
    if (!parsed.success) throw new AppError("PROVIDER_UNAVAILABLE", "zeroX: unexpected quote schema", 502);
    const base = normalizeIndicative(raw, intent);
    if (!base.liquidityAvailable || !parsed.data.transaction) {
      throw new AppError("ROUTE_UNAVAILABLE", "zeroX: no executable route", 409);
    }
    const tx = parsed.data.transaction;
    return {
      ...base,
      transaction: {
        to: tx.to as Address,
        data: tx.data as Hex,
        value: toBig(tx.value) ?? 0n,
        gas: toBig(tx.gas),
        gasPrice: toBig(tx.gasPrice),
      },
      quoteId: parsed.data.zid ?? null,
      expiresAt: Date.now() + EXECUTABLE_QUOTE_TTL_MS,
    };
  }
}

export const zeroXProvider = new ZeroXTradeProvider();

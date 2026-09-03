import { createHmac } from "node:crypto";
import { serverEnv } from "@/config/env";
import { AppError } from "@/lib/errors";
import { CircuitBreaker, fetchJson, metrics } from "@/lib/http";

/**
 * OKX Onchain OS (DEX API) client: HMAC-SHA256 signed requests.
 * Docs: https://web3.okx.com/build/dev-docs/dex-api  · every endpoint needs key + secret + passphrase.
 * Access is per project: an endpoint the project (or region) is not entitled to answers 401 / 50125,
 * which is recorded here so the rest of the app can show it instead of retrying blindly.
 */
export const OKX_BASE_URL = "https://web3.okx.com";
export const BASE_CHAIN_INDEX = "8453";
const breaker = new CircuitBreaker("okx", 3, 30_000);

export interface OkxAccessState {
  configured: boolean;
  /** "ok" once any signed call succeeded; "no-access" after a 50125; "unknown" before the first call. */
  state: "unknown" | "ok" | "no-access" | "error";
  code?: string;
  message?: string;
  checkedAt?: number;
}

interface Global {
  __bstocksOkx?: OkxAccessState;
}
const g = globalThis as unknown as Global;

export function okxConfigured(): boolean {
  const env = serverEnv();
  return !!(env.OKX_API_KEY && env.OKX_SECRET_KEY && env.OKX_PASSPHRASE);
}

export function okxStatus(): OkxAccessState {
  return g.__bstocksOkx ?? { configured: okxConfigured(), state: "unknown" };
}

function setStatus(patch: Partial<OkxAccessState>) {
  g.__bstocksOkx = { ...okxStatus(), configured: okxConfigured(), checkedAt: Date.now(), ...patch };
}

function signedHeaders(method: "GET" | "POST", pathWithQuery: string, body: string): Record<string, string> {
  const env = serverEnv();
  const ts = new Date().toISOString();
  const sig = createHmac("sha256", env.OKX_SECRET_KEY ?? "").update(ts + method + pathWithQuery + body).digest("base64");
  const h: Record<string, string> = { "OK-ACCESS-KEY": env.OKX_API_KEY ?? "", "OK-ACCESS-SIGN": sig, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": env.OKX_PASSPHRASE ?? "", "content-type": "application/json" };
  if (env.OKX_PROJECT_ID) h["OK-ACCESS-PROJECT"] = env.OKX_PROJECT_ID;
  return h;
}

interface OkxEnvelope {
  code?: string | number;
  msg?: string;
  data?: unknown;
}

/** Signed request; returns `data` of the OKX envelope or throws a typed AppError. */
export async function okxRequest<T = unknown>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  if (!okxConfigured()) throw new AppError("PROVIDER_UNAVAILABLE", "okx: not configured", 503);
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const pathWithQuery = `${path}${qs}`;
  const bodyText = opts.body ? JSON.stringify(opts.body) : "";
  return breaker.run(async () => {
    const { status, data } = await fetchJson<OkxEnvelope>(`${OKX_BASE_URL}${pathWithQuery}`, { method, headers: signedHeaders(method, pathWithQuery, bodyText), body: opts.body, timeoutMs: opts.timeoutMs ?? 6_000, provider: "okx" });
    const code = data?.code === undefined ? undefined : String(data.code);
    if (status === 401 || code === "50125" || code === "50103" || code === "50111" || code === "50113") {
      setStatus({ state: "no-access", code, message: data?.msg });
      throw new AppError("PROVIDER_UNAVAILABLE", `okx: ${data?.msg ?? `http ${status}`} (${code ?? status})`, 503);
    }
    if (status === 429) throw new AppError("PROVIDER_UNAVAILABLE", "okx: rate limited", 503);
    if (status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", `okx: http ${status}`, 502);
    if (code !== undefined && code !== "0") {
      // Business errors (no route, bad params) are not access problems.
      setStatus({ state: "ok" });
      throw new AppError("ROUTE_UNAVAILABLE", `okx: ${data?.msg ?? "no route"} (${code})`, 409);
    }
    setStatus({ state: "ok", code: undefined, message: undefined });
    metrics.count("okx.request", true);
    return data?.data as T;
  });
}

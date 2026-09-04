import type { TradeErrorCode } from "@/domain/trade";
import { B20_ERROR_SELECTORS } from "@/lib/b20/abi";

export type AppErrorCode =
  | TradeErrorCode
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAUTHORIZED"
  | "INTERNAL"
  // Gift pools
  | "POOL_UNAVAILABLE"
  | "POOL_CLOSED"
  | "POOL_EMPTY"
  | "ALREADY_CLAIMED"
  | "QUEST_INCOMPLETE";

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly httpStatus = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/** Human-readable copy per error code (spec §16). */
export const TRADE_ERROR_COPY: Record<TradeErrorCode, string> = {
  INSUFFICIENT_BALANCE: "You don't have enough balance for this trade.",
  ALLOWANCE_REQUIRED: "A one-time approval is needed before this trade can execute.",
  B20_POLICY_BLOCKED: "This transfer is blocked by the issuer's onchain policy for one of the addresses involved.",
  B20_TRANSFER_PAUSED: "Transfers of this stock are currently paused by the issuer.",
  QUOTE_EXPIRED: "The price moved. Please review the refreshed quote.",
  ROUTE_UNAVAILABLE: "No route has enough onchain liquidity for this amount. Try a smaller amount or check back later.",
  SLIPPAGE: "The market moved beyond your slippage tolerance. Please try again.",
  WRONG_NETWORK: "Switch your wallet to Base to continue.",
  USER_REJECTED: "The request was cancelled in your wallet.",
  PROVIDER_UNAVAILABLE: "Trading is temporarily unavailable. Please try again in a moment.",
  ASSET_NOT_CANONICAL: "This asset is not a verified Coinbase Tokenized Stock.",
  ASSET_NOT_VERIFIED: "This asset has not been verified for trading yet.",
  AMOUNT_TOO_SMALL: "Amount is below the minimum trade size.",
  SIMULATION_FAILED: "We couldn't simulate this transaction. Nothing was sent.",
  WALLET_NOT_CONNECTED: "Connect a wallet to continue.",
  UNKNOWN: "Something went wrong. Nothing was sent.",
  REGION_RESTRICTED: "Trading and Earn are not available in your region. Coinbase Tokenized Stocks are only for eligible persons outside the United States.",
};

export interface HumanError {
  code: TradeErrorCode;
  message: string;
  /** Raw technical detail for the collapsed "Execution details" section only. */
  detail?: string;
}

interface ErrorLike {
  name?: string;
  message?: string;
  shortMessage?: string;
  code?: number | string;
  data?: unknown;
  cause?: unknown;
}

function walk(err: unknown, visit: (e: ErrorLike) => void, depth = 0): void {
  if (!err || typeof err !== "object" || depth > 8) return;
  const e = err as ErrorLike;
  visit(e);
  walk(e.cause, visit, depth + 1);
}

/** Map wallet/RPC/provider errors to human-readable copy. Never surfaces raw RPC text as the primary message. */
export function humanizeError(err: unknown): HumanError {
  if (err instanceof AppError) {
    const code = (err.code in TRADE_ERROR_COPY ? err.code : "UNKNOWN") as TradeErrorCode;
    return { code, message: err.message || TRADE_ERROR_COPY[code], detail: err.message };
  }

  let code: TradeErrorCode = "UNKNOWN";
  const text: string[] = [];
  const details: string[] = [];

  walk(err, (e) => {
    if (e.name) text.push(e.name);
    if (e.shortMessage) {
      text.push(e.shortMessage);
      details.push(e.shortMessage);
    }
    if (e.message) {
      text.push(e.message);
      details.push(e.message);
    }
    if (typeof e.data === "string") text.push(e.data);
    if (e.code !== undefined) text.push(String(e.code));
  });
  const detail = details[0] ?? text[0] ?? String(err);
  const joined = text.join(" | ");
  const lower = joined.toLowerCase();

  for (const [selector, name] of Object.entries(B20_ERROR_SELECTORS)) {
    if (lower.includes(selector)) {
      if (name === "PolicyForbids" || name === "InvalidSender" || name === "InvalidReceiver") code = "B20_POLICY_BLOCKED";
      else if (name === "ContractPaused") code = "B20_TRANSFER_PAUSED";
      else if (name === "InsufficientBalance") code = "INSUFFICIENT_BALANCE";
      else if (name === "InsufficientAllowance") code = "ALLOWANCE_REQUIRED";
      return { code, message: TRADE_ERROR_COPY[code], detail: `${name} (${selector})` };
    }
  }

  if (/user rejected|user denied|rejected the request|4001/.test(lower)) code = "USER_REJECTED";
  else if (/chain ?mismatch|wrong network|chainid|unsupported chain|switch chain|current chain of the wallet/.test(lower)) code = "WRONG_NETWORK";
  else if (/policyforbids|policy/.test(lower)) code = "B20_POLICY_BLOCKED";
  else if (/paused/.test(lower)) code = "B20_TRANSFER_PAUSED";
  else if (/insufficient funds|insufficient balance|exceeds balance|transfer amount exceeds/.test(lower)) code = "INSUFFICIENT_BALANCE";
  else if (/allowance|erc20: insufficient allowance|transferfrom failed/.test(lower)) code = "ALLOWANCE_REQUIRED";
  else if (/slippage|too little received|insufficient output|min.*buy|minbuyamount/.test(lower)) code = "SLIPPAGE";
  else if (/expired|deadline/.test(lower)) code = "QUOTE_EXPIRED";
  else if (/no route|liquidity|route unavailable/.test(lower)) code = "ROUTE_UNAVAILABLE";
  else if (/timeout|circuit open|network error|502|503|fetch failed/.test(lower)) code = "PROVIDER_UNAVAILABLE";
  else if (/simulat|execution reverted|revert/.test(lower)) code = "SIMULATION_FAILED";

  return { code, message: TRADE_ERROR_COPY[code], detail: detail.slice(0, 300) };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(err.toJSON(), { status: err.httpStatus });
  }
  const h = humanizeError(err);
  const status = h.code === "PROVIDER_UNAVAILABLE" ? 503 : 500;
  return Response.json({ error: { code: h.code, message: h.message } }, { status });
}

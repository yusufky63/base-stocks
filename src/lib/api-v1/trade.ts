import { Attribution } from "ox/erc8021";
import { concatHex, encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { publicEnv } from "@/config/env";
import { isNativeEth } from "@/config/chain";
import type { ExecutableQuoteDTO } from "@/domain/trade";

/**
 * The public trade builder's pure half: a firm quote from the app's own router in, the calls a
 * wallet sends out. The route around it adds the limits, the eligibility rule and the lookup.
 *
 * Nothing here signs or sends. The approval is for the exact amount sold, to the exact spender the
 * route needs, as the app's own trade panel does; native ETH needs none.
 */

/** Requests a minute one caller may build: each one asks every trading provider for a firm quote. */
export const V1_TRADE_LIMIT = { limit: 30, windowMs: 60_000 } as const;

/** A builder code the ERC-8021 suffix can carry: codes are joined with commas, so none may contain one. */
export const BUILDER_CODE = /^[A-Za-z0-9_-]{2,32}$/;

/** The app's own code, plus the caller's when it sends a valid one, in one suffix. */
export function tradeDataSuffix(partnerCode?: string | null): Hex | null {
  const codes = [publicEnv.builderCode.trim(), partnerCode?.trim() ?? ""]
    .filter((code) => BUILDER_CODE.test(code))
    .filter((code, i, all) => all.indexOf(code) === i);
  return codes.length > 0 ? Attribution.toDataSuffix({ codes }) : null;
}

export interface V1TradeCall {
  to: Address;
  data: Hex;
  /** Wei, as a decimal string. Non-zero only when paying with ETH. */
  value: string;
  description: "approve" | "trade";
}

export interface V1TradeApproval {
  token: Address;
  spender: Address;
  amount: string;
}

/**
 * The calls for one quote, in the order they must be sent. Null when the quote carries no
 * transaction to send (a route that only offers a signed order, which this endpoint does not ask for).
 */
export function tradeCalls(quote: ExecutableQuoteDTO, builderCode?: string | null): { calls: V1TradeCall[]; approval: V1TradeApproval | null } | null {
  if (!quote.transaction) return null;
  const suffix = tradeDataSuffix(builderCode);
  const attributed = (data: Hex): Hex => (suffix ? concatHex([data, suffix]) : data);
  const spender = quote.allowanceSpender;
  const approval: V1TradeApproval | null =
    quote.allowanceRequired && spender && !isNativeEth(quote.sellToken) ? { token: quote.sellToken, spender, amount: quote.sellAmount } : null;

  const calls: V1TradeCall[] = [];
  if (approval) {
    calls.push({
      to: approval.token,
      data: attributed(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [approval.spender, BigInt(approval.amount)] })),
      value: "0",
      description: "approve",
    });
  }
  calls.push({ to: quote.transaction.to, data: attributed(quote.transaction.data), value: quote.transaction.value, description: "trade" });
  return { calls, approval };
}

import type { Address } from "viem";
import { serverEnv } from "@/config/env";

/**
 * The integrator fee: what BStocks charges on a trade, in basis points, paid by the route to a
 * named recipient. Off unless both the rate and the recipient are configured.
 *
 * Only routes whose API takes a fee natively *and* prices it into the quote charge it —
 * KyberSwap (`chargeFeeBy`, in the route summary), CoW (`partnerFee` in the app data the quote
 * is asked with) and 0x (`swapFeeBps`). Velora applies a partner fee only when the transaction
 * is built, after the price was shown, so it is left out rather than quoted dishonestly;
 * Aerodrome direct, the Uniswap Trading API and OKX carry none. A fee appears on a quote only
 * when that quote's route will actually charge it, never averaged in.
 */
export interface IntegratorFee {
  bps: number;
  recipient: Address;
}

/** Routes that can carry the fee, by provider id. */
export const FEE_PROVIDERS: ReadonlySet<string> = new Set(["kyber", "cow", "zeroX"]);
/** Hard ceiling regardless of configuration: 1%. */
export const MAX_FEE_BPS = 100;

export function integratorFee(): IntegratorFee | null {
  const env = serverEnv();
  const bps = env.INTEGRATOR_FEE_BPS ?? env.ZEROX_SWAP_FEE_BPS ?? 0;
  const recipient = env.INTEGRATOR_FEE_RECIPIENT ?? env.ZEROX_SWAP_FEE_RECIPIENT;
  if (!bps || bps <= 0 || !recipient) return null;
  return { bps: Math.min(MAX_FEE_BPS, Math.round(bps)), recipient: recipient as Address };
}

/** The rate a trade through `provider` carries: the configured fee where the route supports it, else zero. */
export function feeBpsFor(provider: string): number {
  const fee = integratorFee();
  if (!fee || !FEE_PROVIDERS.has(provider)) return 0;
  return fee.bps;
}

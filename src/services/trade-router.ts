import { erc20Abi, formatUnits, type Address } from "viem";
import { BASE_CHAIN_ID, DEFAULT_SLIPPAGE_BPS, MIN_TRADE_USD, NATIVE_ETH, NATIVE_ETH_DECIMALS, USDC_ADDRESS, USDC_DECIMALS, isNativeEth } from "@/config/chain";
import type { B20Asset } from "@/domain/asset";
import type { PriceView } from "@/domain/market";
import type { ExecutableQuote, ExecutableQuoteDTO, IndicativeQuote, TradeIntent, TradeProvider, TradeProviderId, TradeQuoteAlternative, TradeQuoteSummary, TradeSide } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { cached } from "@/lib/cache";
import { equityPricePerShare } from "@/lib/b20/math";
import { getTradeProviders, isKnownTarget } from "@/providers/trading";
import { COMPARE_TIMEOUT_MS } from "@/providers/trading/budget";
import { raceWithFallback } from "@/lib/fallback";
import { b20Guard } from "./b20-guard-service";
import { getEthUsd, getMarketDataMap, buildPriceView, impactBasis } from "./price-service";
import { getServerPublicClient } from "@/lib/viem/server-client";

export interface TradeRequest {
  side: TradeSide;
  /** Buys can be paid with USDC (default) or native ETH; sells always receive USDC. */
  payWith?: "USDC" | "ETH";
  assetAddress: Address;
  /** Base units of the token being sold (USDC for buy, B20 for sell). */
  sellAmount: bigint;
  taker?: Address;
  recipient?: Address;
  slippageBps?: number;
  chainId?: number;
  /** Provider that won the indicative comparison; tried first for the executable quote. */
  provider?: TradeProviderId;
  /** Manual choice from the comparison: use exactly this provider, no fallback. */
  strictProvider?: boolean;
  /** Allow signed-order providers (CoW). Basket legs set false: each leg must be a transaction with a hash. */
  orders?: boolean;
  /** Server-set from the request's country: 0x's API terms exclude US persons, so US requests skip it. Never read from the client body. */
  noZeroX?: boolean;
}

/**
 * Hedge delay before the fallback provider is started in parallel. Kyber's firm quote is a route
 * call and then a build call, which together take about two seconds on a normal day; at 1.2 s the
 * hedge was firing on nearly every Kyber quote and paying a second provider for nothing.
 */
const HEDGE_DELAY_MS = 2_200;

/**
 * A sale pays its USDC to the wallet that sold. A recipient on a sell would route the proceeds
 * elsewhere, which is a transfer dressed as a trade; buys deliver the stock to a recipient, sells
 * never redirect the money.
 */
function validateRecipient(req: TradeRequest): void {
  if (req.side !== "sell" || !req.recipient) return;
  if (req.taker && req.recipient.toLowerCase() === req.taker.toLowerCase()) return;
  throw new AppError("BAD_REQUEST", "A sale pays its proceeds to the wallet that sells; a recipient can only be set on a buy.", 400);
}

function buildIntent(req: TradeRequest, asset: B20Asset): TradeIntent {
  const buy = req.side === "buy";
  const eth = buy && req.payWith === "ETH";
  return {
    chainId: BASE_CHAIN_ID,
    side: req.side,
    assetAddress: asset.address,
    sellToken: buy ? (eth ? NATIVE_ETH : USDC_ADDRESS) : asset.address,
    buyToken: buy ? asset.address : USDC_ADDRESS,
    sellAmount: req.sellAmount,
    sellTokenDecimals: buy ? (eth ? NATIVE_ETH_DECIMALS : USDC_DECIMALS) : asset.decimals,
    buyTokenDecimals: buy ? asset.decimals : USDC_DECIMALS,
    taker: req.taker,
    // After validateRecipient a sell's recipient is absent or the taker itself; the adapters need neither.
    recipient: buy ? req.recipient : undefined,
    slippageBps: req.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
  };
}

function validateAmount(req: TradeRequest, asset: B20Asset, priceUsd: number | null, ethUsd: number | null): void {
  if (req.sellAmount <= 0n) throw new AppError("AMOUNT_TOO_SMALL", "Enter an amount to trade.", 400);
  if (req.side === "buy") {
    const eth = req.payWith === "ETH";
    if (eth && ethUsd === null) throw new AppError("PROVIDER_UNAVAILABLE", "ETH price unavailable right now; pay with USDC or try again.", 503);
    const usd = eth ? Number(formatUnits(req.sellAmount, NATIVE_ETH_DECIMALS)) * (ethUsd ?? 0) : Number(formatUnits(req.sellAmount, USDC_DECIMALS));
    if (usd < MIN_TRADE_USD) throw new AppError("AMOUNT_TOO_SMALL", `Minimum trade is $${MIN_TRADE_USD}.`, 400);
  } else if (priceUsd !== null) {
    const usd = Number(formatUnits(req.sellAmount, asset.decimals)) * priceUsd;
    if (usd < MIN_TRADE_USD * 0.5) throw new AppError("AMOUNT_TOO_SMALL", `Amount is below the minimum trade size.`, 400);
  }
}

/**
 * Race the primary provider against a hedged fallback chain (see lib/fallback.ts).
 * First success wins; a fast primary failure starts the fallback immediately.
 */
function withFallback<T>(providers: TradeProvider[], run: (p: TradeProvider) => Promise<T>): Promise<T> {
  return raceWithFallback(
    providers.map((p, i) => () => {
      if (i > 0) metrics.count("trade.fallbackUsed");
      return run(p);
    }),
    { hedgeDelayMs: HEDGE_DELAY_MS },
  );
}

function executablePrice(side: TradeSide, q: IndicativeQuote, asset: B20Asset, ethUsd: number | null): number | null {
  const quoteToken = side === "buy" ? q.sellToken : q.buyToken;
  const quoteAmount = side === "buy" ? q.sellAmount : q.buyAmount;
  const usd = isNativeEth(quoteToken) ? Number(formatUnits(quoteAmount, NATIVE_ETH_DECIMALS)) * (ethUsd ?? 0) : Number(formatUnits(quoteAmount, USDC_DECIMALS));
  const token = Number(formatUnits(side === "buy" ? q.buyAmount : q.sellAmount, asset.decimals));
  if (token <= 0 || usd <= 0) return null;
  return usd / token;
}

/* ---------- network fee ---------- */

/**
 * Gas a swap through each route typically burns, used only when the route reports neither a fee
 * nor a gas figure. Round numbers from Base transactions through these routers, not measurements
 * of this trade; anything priced with them is marked estimated. CoW is zero because the solver
 * pays the gas and the cost is already inside the quoted amount.
 */
const DEFAULT_GAS_UNITS: Record<TradeProviderId, bigint> = {
  zeroX: 250_000n,
  kyber: 250_000n,
  okx: 250_000n,
  uniswap: 200_000n,
  velora: 250_000n,
  aerodrome: 220_000n,
  cow: 0n,
};

const GAS_PRICE_TTL_MS = 10_000;

/** The chain's current gas price, read once per comparison window rather than once per provider. Null when the RPC will not say. */
async function currentGasPrice(): Promise<bigint | null> {
  try {
    return await cached("trade.gasPrice", { ttlMs: GAS_PRICE_TTL_MS }, () => getServerPublicClient().getGasPrice());
  } catch {
    return null;
  }
}

interface NetworkFee {
  wei: bigint | null;
  usd: number | null;
  /** True when the app priced it (gas × gas price) instead of the provider reporting it. */
  estimated: boolean;
}

/**
 * What this route will cost in gas. Only some providers report a total fee; the rest were scored
 * as if gas were free, so "net after gas" compared a 0x quote minus its fee with a Velora quote
 * minus nothing. A route that reports gas units gets them priced at the current gas price; one
 * that reports nothing gets the default above. Both are estimates and say so.
 */
export function networkFee(q: IndicativeQuote, gasPrice: bigint | null, ethUsd: number | null): NetworkFee {
  const usdOf = (wei: bigint) => (ethUsd !== null ? Number(formatUnits(wei, 18)) * ethUsd : null);
  if (q.totalNetworkFeeWei !== null) return { wei: q.totalNetworkFeeWei, usd: usdOf(q.totalNetworkFeeWei), estimated: false };
  const price = q.gasPrice ?? gasPrice;
  if (price === null) return { wei: null, usd: null, estimated: true };
  const wei = (q.gas ?? DEFAULT_GAS_UNITS[q.provider]) * price;
  return { wei, usd: usdOf(wei), estimated: true };
}

/* ---------- price bases ---------- */

/**
 * What "price impact" is measured against: the pool's own mid price when the market price is
 * trusted, because impact is what this trade does to the pool. A pool standing 12% above the
 * stock is a premium, not impact, and reporting it as impact made a $10 buy look like it moved
 * the market. Without a trusted market price the reference stands in, as before.
 */
function impactBasisFor(view: PriceView): { price: number; basis: "reference" | "market" } | null {
  if (view.displaySource === "market" && typeof view.marketUsd === "number" && view.marketUsd > 0) return { price: view.marketUsd, basis: "market" };
  return impactBasis(view);
}

/** The Chainlink reference when it can be trusted; the separate "vs reference" figure is measured against this. */
function referencePriceFor(view: PriceView): number | null {
  if (typeof view.referenceUsd !== "number" || !(view.referenceUsd > 0)) return null;
  if (view.referenceStale || view.referencePaused) return null;
  return view.referenceUsd;
}

/**
 * Whether the taker actually holds what the quote proposes to spend.
 *
 * Only 0x reports this; every other adapter returns a hardcoded false next to `simulationIncomplete:
 * true`, meaning "I did not look". Trusting that made a plain empty wallet fail as a bundle
 * simulation revert with no reason attached — the app knew nothing, so it said nothing useful. One
 * balance read makes the answer true whichever route wins.
 */
async function sellSideShort(taker: Address | undefined, sellToken: Address, sellAmount: bigint): Promise<boolean> {
  if (!taker) return false;
  try {
    const client = getServerPublicClient();
    const held = isNativeEth(sellToken)
      ? await client.getBalance({ address: taker })
      : await client.readContract({ address: sellToken, abi: erc20Abi, functionName: "balanceOf", args: [taker] });
    return held < sellAmount;
  } catch {
    // A read that fails is not evidence of an empty wallet; the simulation still stands behind it.
    return false;
  }
}

async function summarize(req: TradeRequest, asset: B20Asset, q: IndicativeQuote, warnings: string[]): Promise<TradeQuoteSummary> {
  const needsGasPrice = q.totalNetworkFeeWei === null && q.gasPrice === null;
  const [md, ethUsd, short, gasPrice] = await Promise.all([getMarketDataMap([asset.address]), getEthUsd(), sellSideShort(req.taker, q.sellToken, q.sellAmount), needsGasPrice ? currentGasPrice() : Promise.resolve(null)]);
  const view = buildPriceView(asset, md.get(asset.canonicalId) ?? null);
  const exec = executablePrice(req.side, q, asset, ethUsd);
  const basis = impactBasisFor(view);
  const priceImpactPct = basis ? quoteDeviationPct(req.side, exec, basis.price) : null;
  const referenceGapPct = quoteDeviationPct(req.side, exec, referencePriceFor(view));
  const fee = networkFee(q, gasPrice, ethUsd);
  // The trade's dollar size, for pricing the integrator fee: the USDC leg when there is one, else the ETH paid.
  const usdcSide = q.sellToken.toLowerCase() === USDC_ADDRESS.toLowerCase() ? q.sellAmount : q.buyToken.toLowerCase() === USDC_ADDRESS.toLowerCase() ? q.buyAmount : null;
  const tradeUsd = usdcSide !== null ? Number(formatUnits(usdcSide, USDC_DECIMALS)) : isNativeEth(q.sellToken) && ethUsd !== null ? Number(formatUnits(q.sellAmount, NATIVE_ETH_DECIMALS)) * ethUsd : null;
  const integratorFee = q.integratorFeeBps ? { bps: q.integratorFeeBps, usd: tradeUsd !== null ? (tradeUsd * q.integratorFeeBps) / 10_000 : null } : null;
  return {
    provider: q.provider,
    side: req.side,
    assetAddress: asset.address,
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    sellAmount: q.sellAmount.toString(),
    buyAmount: q.buyAmount.toString(),
    minBuyAmount: q.minBuyAmount?.toString() ?? null,
    executablePriceUsd: exec,
    executablePricePerShareUsd: exec !== null ? equityPricePerShare(exec, asset.multiplier, asset.wadPrecision) : null,
    priceImpactPct,
    priceImpactBasis: basis?.basis ?? null,
    referenceGapPct,
    estimatedNetworkFeeWei: fee.wei?.toString() ?? null,
    estimatedNetworkFeeUsd: fee.usd,
    networkFeeEstimated: fee.estimated,
    integratorFee,
    liquidityAvailable: q.liquidityAvailable,
    allowanceRequired: q.issues.allowanceRequired,
    allowanceSpender: q.issues.allowanceSpender ?? q.allowanceTarget,
    balanceInsufficient: q.issues.balanceInsufficient || short,
    route: q.route,
    fetchedAt: q.fetchedAt,
    warnings,
  };
}

/**
 * How far the best quote may stand above the runner-up before it is treated as a claim rather than
 * an offer. Routers disagree by fractions of a percent on the same pools; a fifth more output is
 * not a better route.
 */
const IMPLAUSIBLE_WINNER_RATIO = 1.1;

/**
 * How far a quote's executable price may sit from the stock's reference (or, failing a live
 * reference, its market price) before it is refused outright, in either direction.
 *
 * A quote far *below* the reference describes liquidity that is not there (the swap reverts on its
 * own minimum output); a quote far *above* it is a pool with nothing in it. The Aerodrome v2
 * NVDAc/USDC pool holds 0.01 USDC and answers `getAmountsOut` for $10 with 0.000033 NVDAc, an
 * implied $300,000 a token. Nothing refused that, and with only two routes answering the
 * corroboration rule below demoted the honest one for standing "1600% above the field". The
 * trade panel warns at 15% impact; nobody wants a fill three tenths away from the stock.
 */
export const MAX_QUOTE_DEVIATION_PCT = 30;

/**
 * Signed distance of an executable price from the basis, in the trade panel's convention: positive
 * is worse for the user (paying more on a buy, receiving less on a sell), negative is better than
 * the reference, which for anything beyond routing noise means a quote no pool will honour.
 */
export function quoteDeviationPct(side: TradeSide, executablePriceUsd: number | null, basisPrice: number | null): number | null {
  if (executablePriceUsd === null || basisPrice === null || !(basisPrice > 0) || !Number.isFinite(executablePriceUsd)) return null;
  const raw = ((executablePriceUsd - basisPrice) / basisPrice) * 100;
  return side === "buy" ? raw : -raw;
}

function implausibleDeviationError(deviationPct: number): string {
  const away = Math.round(Math.abs(deviationPct));
  return deviationPct < 0 ? `Quoted ${away}% better than the stock's reference; no pool backs that price, so the swap would revert.` : `Quoted ${away}% worse than the stock's reference; the pool behind it is too shallow to fill this.`;
}

/* ---------- target allowlist ---------- */

/**
 * The contracts a quote may put in front of the wallet. A quote's `to` and spender used to come
 * straight out of the provider response and go straight into the wallet; a spoofed or compromised
 * response could have had the user approve and call anything. Each adapter names the contracts
 * its provider is known to use (see providers/trading/targets.ts); a quote naming anything else
 * cannot win the comparison and is refused as a firm quote.
 */
function unknownTargetReason(q: IndicativeQuote | ExecutableQuote): string | null {
  const named: Array<[string, Address | null | undefined]> = [];
  if ("transaction" in q && q.transaction) named.push(["transaction target", q.transaction.to]);
  if (!isNativeEth(q.sellToken)) named.push(["spender", q.issues.allowanceSpender ?? q.allowanceTarget]);
  if ("order" in q && q.order) named.push(["order settlement", q.order.typedData.domain.verifyingContract], ["order spender", q.order.allowanceTarget]);
  for (const [what, address] of named) {
    if (address && !isKnownTarget(q.provider, address)) return `${what} ${address} is not a contract this route is known to use`;
  }
  return null;
}

function assertKnownTargets(q: ExecutableQuote): void {
  const reason = unknownTargetReason(q);
  if (!reason) return;
  metrics.count("trade.unknownTarget", false, `${q.provider}: ${reason}`);
  throw new AppError("PROVIDER_UNAVAILABLE", `This route named a contract the app does not recognise, so the trade was not built. Pick another route.`, 502, { provider: q.provider, reason });
}

/**
 * Refuse a winning quote that no other router can corroborate.
 *
 * Nothing checked what a provider claimed it would return. Selling $4.87 of GOOGLc, Velora quoted
 * $6.24 through a Uniswap v4 route while six other routers agreed on $4.85–4.87 — so the app picked
 * it, set the minimum output from the inflated figure, and the swap could not possibly satisfy it.
 * The user got "execution reverted for an unknown reason", which is what a lie looks like from
 * inside a simulation.
 *
 * The field is the check: on the same pools, routers land within a fraction of a percent of each
 * other, so a quote standing far above the median of the rest is describing liquidity that is not
 * there. It stays in the comparison, with its reason, rather than vanishing — but it cannot win, and
 * the best quote the others agree with takes the trade.
 *
 * With exactly two quotes there is no field, only a disagreement, and the earlier rule simply
 * demoted the higher one; when the lower one was the dust quote above, that handed the trade to the
 * dust. The reference arbitrates that case now: the quote closer to the stock's price is the one
 * believed. A lone quote has nothing to be checked against; the deviation gate covers that case.
 */
function demoteImplausibleWinner(ok: Array<{ alt: TradeQuoteAlternative; q: IndicativeQuote | null; score: number }>, basisPrice: number | null): void {
  while (ok.length >= 2) {
    const best = ok[0]!;
    const rest = ok.slice(1);
    let corroborated: boolean;
    if (rest.length >= 2) {
      const scores = rest.map((r) => r.score).sort((a, b) => a - b);
      const mid = scores.length % 2 ? scores[(scores.length - 1) / 2]! : (scores[scores.length / 2 - 1]! + scores[scores.length / 2]!) / 2;
      corroborated = !(mid > 0 && best.score > mid * IMPLAUSIBLE_WINNER_RATIO);
    } else {
      const runnerUp = rest[0]!;
      if (!(runnerUp.score > 0 && best.score > runnerUp.score * IMPLAUSIBLE_WINNER_RATIO)) corroborated = true;
      else if (basisPrice !== null && basisPrice > 0 && best.alt.executablePriceUsd !== null && runnerUp.alt.executablePriceUsd !== null)
        corroborated = Math.abs(best.alt.executablePriceUsd - basisPrice) <= Math.abs(runnerUp.alt.executablePriceUsd - basisPrice);
      else corroborated = false;
    }
    if (corroborated) return;
    const against = rest.length >= 2 ? "the other routes" : "the only other route";
    const over = Math.round((best.score / Math.max(...rest.map((r) => r.score)) - 1) * 100);
    best.alt.error = `Quoted ${over}% above ${against}; no pool backs that price, so the swap would revert.`;
    best.alt.buyAmount = null;
    best.alt.netUsd = null;
    best.q = null;
    metrics.count("trade.implausible", false, `${best.alt.provider} +${over}%`);
    // `scored` still holds it with q === null, so the alternatives list picks it up with its reason.
    ok.shift();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError("PROVIDER_UNAVAILABLE", `timeout after ${ms}ms`, 504)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

interface Comparison {
  best: IndicativeQuote;
  alternatives: TradeQuoteAlternative[];
}

/**
 * Ask every configured provider at once and keep the best NET result: output valued in USD minus
 * the estimated network fee. The losers are returned as alternatives so the UI can show the
 * comparison. Falls back to a single hedged race only if nothing answers.
 *
 * Without a USD price for the stock there is no net: the routes are ranked by raw output instead,
 * and `netUsd` stays null rather than wearing a raw token count as dollars.
 */
async function compareProviders(intent: TradeIntent, asset: B20Asset, side: TradeSide, orders: boolean, zeroX: boolean): Promise<Comparison> {
  const providers = getTradeProviders({ orders, zeroX });
  const [md, ethUsd, gasPrice] = await Promise.all([getMarketDataMap([asset.address]), getEthUsd(), currentGasPrice()]);
  const view = buildPriceView(asset, md.get(asset.canonicalId) ?? null);
  const tokenUsd = view.displayUsd ?? asset.oracle?.priceUsd ?? null;
  const basisPrice = impactBasis(view)?.price ?? null;
  const started = Date.now();
  const results = await Promise.allSettled(providers.map((p) => withTimeout(p.getIndicativeQuote(intent), COMPARE_TIMEOUT_MS).then((q) => ({ q, latencyMs: Date.now() - started }))));
  const scored: Array<{ alt: TradeQuoteAlternative; q: IndicativeQuote | null; score: number }> = results.map((r, i) => {
    const provider = providers[i]!.id;
    if (r.status === "rejected" || !r.value.q.liquidityAvailable) {
      const err = r.status === "rejected" ? r.reason : null;
      const message = err instanceof Error ? err.message : r.status === "rejected" ? String(err) : "no liquidity";
      return { alt: { provider, buyAmount: null, netUsd: null, latencyMs: r.status === "fulfilled" ? r.value.latencyMs : Date.now() - started, route: "", error: message.slice(0, 120), best: false, outUsd: null, estimatedNetworkFeeUsd: null, executablePriceUsd: null }, q: null, score: -Infinity };
    }
    const q = r.value.q;
    const outUsd = side === "buy" ? (tokenUsd !== null ? Number(formatUnits(q.buyAmount, asset.decimals)) * tokenUsd : null) : Number(formatUnits(q.buyAmount, USDC_DECIMALS));
    const fee = networkFee(q, gasPrice, ethUsd);
    const netUsd = outUsd !== null ? outUsd - (fee.usd ?? 0) : null;
    const score = netUsd ?? Number(formatUnits(q.buyAmount, side === "buy" ? asset.decimals : USDC_DECIMALS));
    const exec = executablePrice(side, q, asset, ethUsd);
    const deviation = quoteDeviationPct(side, exec, basisPrice);
    const alt: TradeQuoteAlternative = { provider, buyAmount: q.buyAmount.toString(), netUsd, latencyMs: r.value.latencyMs, route: q.route.map((f) => f.source).join(", "), best: false, outUsd, estimatedNetworkFeeUsd: fee.usd, networkFeeEstimated: fee.estimated, executablePriceUsd: exec };
    if (deviation !== null && Math.abs(deviation) > MAX_QUOTE_DEVIATION_PCT) {
      // A price no pool can be holding stays in the comparison with its reason, but it can neither
      // win nor stand in as the runner-up that "corroborates" someone else.
      metrics.count("trade.implausible", false, `${provider} ${deviation > 0 ? "+" : ""}${Math.round(deviation)}% vs reference`);
      return { alt: { ...alt, buyAmount: null, netUsd: null, error: implausibleDeviationError(deviation) }, q: null, score: -Infinity };
    }
    const unknown = unknownTargetReason(q);
    if (unknown) {
      metrics.count("trade.unknownTarget", false, `${provider}: ${unknown}`);
      return { alt: { ...alt, buyAmount: null, netUsd: null, error: `Names a contract this app does not recognise (${unknown}).` }, q: null, score: -Infinity };
    }
    return { alt, q, score };
  });
  const ok = scored.filter((x) => x.q !== null).sort((a, b) => b.score - a.score);
  demoteImplausibleWinner(ok, basisPrice);
  if (ok.length === 0) {
    const errors = scored.map((x) => x.alt.error ?? "").filter(Boolean);
    const unbacked = errors.length > 0 && errors.every((e) => /reference/i.test(e));
    const liquidity = errors.some((e) => /liquidity|no route|route not found/i.test(e));
    if (unbacked) throw new AppError("ROUTE_UNAVAILABLE", `Every route priced this stock more than ${MAX_QUOTE_DEVIATION_PCT}% away from its reference, so no pool is really trading it at that size right now. Try a smaller amount or check back later.`, 409, { providers: errors.join(" | ") });
    throw new AppError(liquidity ? "ROUTE_UNAVAILABLE" : "PROVIDER_UNAVAILABLE", liquidity ? "No route has enough onchain liquidity for this amount. Try a smaller amount or check back later." : "Trading is temporarily unavailable.", liquidity ? 409 : 503, { providers: errors.join(" | ") });
  }
  ok[0]!.alt.best = true;
  const alternatives = [...ok.map((x) => x.alt), ...scored.filter((x) => x.q === null).map((x) => x.alt)];
  metrics.count(`trade.compare.best.${ok[0]!.alt.provider}`);
  return { best: ok[0]!.q!, alternatives };
}

/**
 * How long one comparison answers for everyone who asks the same question. The sheet re-asks on
 * every re-render that changes nothing, a second tab asks again, and the assistant asks for the
 * number the panel just fetched; each ask was seven provider calls. Five seconds is shorter than
 * the sheet's own refresh, so a shown price is never older than it was before.
 *
 * The key carries everything that shapes the answer, the taker included: 0x reports the taker's
 * own balance and allowance in its quote, and a memo shared across wallets would hand one wallet's
 * "insufficient balance" to the next. The amount is the exact base-unit amount, not a rounded
 * bucket, because the returned `sellAmount` is shown back to the user as what they typed.
 */
export const COMPARE_MEMO_MS = 5_000;

function compareKey(intent: TradeIntent, orders: boolean, zeroX: boolean): string {
  return `trade.compare:${intent.side}:${intent.assetAddress.toLowerCase()}:${intent.sellToken.toLowerCase()}:${intent.sellAmount}:${intent.slippageBps}:${intent.taker?.toLowerCase() ?? ""}:${intent.recipient?.toLowerCase() ?? ""}:${orders}:${zeroX}`;
}

export class TradeRouter {
  /** Indicative price for the trade sheet while the user edits the amount. */
  async price(req: TradeRequest): Promise<TradeQuoteSummary> {
    validateRecipient(req);
    const { asset, warnings } = await b20Guard.preTradeCheck({ assetAddress: req.assetAddress, side: req.side, taker: req.taker, recipient: req.recipient, chainId: req.chainId });
    validateAmount(req, asset, asset.oracle?.priceUsd ?? null, req.payWith === "ETH" ? await getEthUsd() : null);
    const intent = buildIntent(req, asset);
    const started = Date.now();
    const orders = req.orders !== false;
    const zeroX = !req.noZeroX;
    const { best, alternatives } = await cached(compareKey(intent, orders, zeroX), { ttlMs: COMPARE_MEMO_MS }, () => compareProviders(intent, asset, req.side, orders, zeroX));
    metrics.count(`trade.price.${best.provider}`);
    const summary = await summarize(req, asset, best, warnings);
    metrics.count("trade.price.latency", true, String(Date.now() - started));
    return { ...summary, alternatives };
  }

  /** Fresh executable quote for review/submit. Short-lived; the client re-fetches on expiry. */
  async quote(req: TradeRequest): Promise<ExecutableQuoteDTO> {
    if (!req.taker) throw new AppError("WALLET_NOT_CONNECTED", "Connect a wallet to continue.", 400);
    validateRecipient(req);
    const { asset, warnings } = await b20Guard.preTradeCheck({ assetAddress: req.assetAddress, side: req.side, taker: req.taker, recipient: req.recipient, chainId: req.chainId });
    validateAmount(req, asset, asset.oracle?.priceUsd ?? null, req.payWith === "ETH" ? await getEthUsd() : null);
    const intent = buildIntent(req, asset);
    // The provider that won the comparison goes first and the hedged chain still covers failures;
    // a manual choice (strictProvider) is honoured exactly so the user signs what they picked.
    const all = getTradeProviders({ orders: req.orders !== false, zeroX: !req.noZeroX });
    const strict = req.strictProvider && req.provider ? all.filter((p) => p.id === req.provider) : [];
    if (req.strictProvider && req.provider && strict.length === 0) {
      if (req.provider === "zeroX" && req.noZeroX) throw new AppError("PROVIDER_UNAVAILABLE", "0x does not serve US users; pick another route.", 451);
      throw new AppError("PROVIDER_UNAVAILABLE", "The provider you picked is not available right now. Switch back to the best route.", 503);
    }
    const ordered = strict.length ? strict : [...all].sort((a, b) => Number(b.id === req.provider) - Number(a.id === req.provider));
    const q: ExecutableQuote = await withFallback(ordered, (p) => p.getExecutableQuote(intent));
    metrics.count(`trade.quote.${q.provider}`);
    assertKnownTargets(q);
    const summary = await summarize(req, asset, q, warnings);
    // The firm quote gets the same gate as the comparison: the fallback chain ends at the direct
    // pool adapter, and a firm quote is what sets the minimum output the user signs. The gate
    // measures against the reference first and the market price failing that, as the comparison does.
    const deviation = summary.referenceGapPct ?? summary.priceImpactPct;
    if (deviation !== null && deviation !== undefined && Math.abs(deviation) > MAX_QUOTE_DEVIATION_PCT) {
      metrics.count("trade.implausible", false, `${q.provider} firm ${deviation > 0 ? "+" : ""}${Math.round(deviation)}% vs reference`);
      throw new AppError("ROUTE_UNAVAILABLE", `${implausibleDeviationError(deviation)} Try again for a fresh quote, or a smaller amount.`, 409, { provider: q.provider, deviationPct: deviation });
    }
    return {
      ...summary,
      transaction: q.transaction
        ? {
            to: q.transaction.to,
            data: q.transaction.data,
            value: q.transaction.value.toString(),
            gas: q.transaction.gas?.toString() ?? null,
            gasPrice: q.transaction.gasPrice?.toString() ?? null,
          }
        : null,
      order: q.order,
      quoteId: q.quoteId,
      expiresAt: q.expiresAt,
    };
  }
}

export const tradeRouter = new TradeRouter();

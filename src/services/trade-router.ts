import { formatUnits, type Address } from "viem";
import { BASE_CHAIN_ID, DEFAULT_SLIPPAGE_BPS, MIN_TRADE_USD, NATIVE_ETH, NATIVE_ETH_DECIMALS, USDC_ADDRESS, USDC_DECIMALS, isNativeEth } from "@/config/chain";
import type { B20Asset } from "@/domain/asset";
import type { ExecutableQuote, ExecutableQuoteDTO, IndicativeQuote, TradeIntent, TradeProvider, TradeProviderId, TradeQuoteAlternative, TradeQuoteSummary, TradeSide } from "@/domain/trade";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";
import { equityPricePerShare } from "@/lib/b20/math";
import { getTradeProviders } from "@/providers/trading";
import { raceWithFallback } from "@/lib/fallback";
import { b20Guard } from "./b20-guard-service";
import { getEthUsd, getMarketDataMap, buildPriceView, impactBasis } from "./price-service";

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

/** Hedge delay before the fallback provider is started in parallel. */
const HEDGE_DELAY_MS = 1_200;

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
    recipient: req.recipient,
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

async function summarize(req: TradeRequest, asset: B20Asset, q: IndicativeQuote, warnings: string[]): Promise<TradeQuoteSummary> {
  const [md, ethUsd] = await Promise.all([getMarketDataMap([asset.address]), getEthUsd()]);
  const view = buildPriceView(asset, md.get(asset.canonicalId) ?? null);
  const exec = executablePrice(req.side, q, asset, ethUsd);
  const basis = impactBasis(view);
  let priceImpactPct: number | null = null;
  if (exec !== null && basis && basis.price > 0) {
    const raw = ((exec - basis.price) / basis.price) * 100;
    priceImpactPct = req.side === "buy" ? raw : -raw;
  }
  const feeUsd = q.totalNetworkFeeWei !== null && ethUsd !== null ? Number(formatUnits(q.totalNetworkFeeWei, 18)) * ethUsd : null;
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
    estimatedNetworkFeeWei: q.totalNetworkFeeWei?.toString() ?? null,
    estimatedNetworkFeeUsd: feeUsd,
    integratorFee,
    liquidityAvailable: q.liquidityAvailable,
    allowanceRequired: q.issues.allowanceRequired,
    allowanceSpender: q.issues.allowanceSpender ?? q.allowanceTarget,
    balanceInsufficient: q.issues.balanceInsufficient,
    route: q.route,
    fetchedAt: q.fetchedAt,
    warnings,
  };
}


/** Per-provider budget for the comparison: a slow provider must not hold the sheet (guide §43). */
const COMPARE_TIMEOUT_MS = 2_500;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new AppError("PROVIDER_UNAVAILABLE", `timeout after ${ms}ms`, 504)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Ask every configured provider at once and keep the best NET result: output valued in USD minus
 * the estimated network fee. The losers are returned as alternatives so the UI can show the
 * comparison. Falls back to a single hedged race only if nothing answers.
 */
async function compareProviders(intent: TradeIntent, asset: B20Asset, side: TradeSide, orders: boolean, zeroX: boolean): Promise<{ best: IndicativeQuote; alternatives: TradeQuoteAlternative[] }> {
  const providers = getTradeProviders({ orders, zeroX });
  const [md, ethUsd] = await Promise.all([getMarketDataMap([asset.address]), getEthUsd()]);
  const view = buildPriceView(asset, md.get(asset.canonicalId) ?? null);
  const tokenUsd = view.displayUsd ?? asset.oracle?.priceUsd ?? null;
  const started = Date.now();
  const results = await Promise.allSettled(providers.map((p) => withTimeout(p.getIndicativeQuote(intent), COMPARE_TIMEOUT_MS).then((q) => ({ q, latencyMs: Date.now() - started }))));
  const scored: Array<{ alt: TradeQuoteAlternative; q: IndicativeQuote | null; net: number }> = results.map((r, i) => {
    const provider = providers[i]!.id;
    if (r.status === "rejected" || !r.value.q.liquidityAvailable) {
      const err = r.status === "rejected" ? r.reason : null;
      const message = err instanceof Error ? err.message : r.status === "rejected" ? String(err) : "no liquidity";
      return { alt: { provider, buyAmount: null, netUsd: null, latencyMs: r.status === "fulfilled" ? r.value.latencyMs : Date.now() - started, route: "", error: message.slice(0, 120), best: false, outUsd: null, estimatedNetworkFeeUsd: null, executablePriceUsd: null }, q: null, net: -Infinity };
    }
    const q = r.value.q;
    const outUsd = side === "buy" ? (tokenUsd !== null ? Number(formatUnits(q.buyAmount, asset.decimals)) * tokenUsd : null) : Number(formatUnits(q.buyAmount, USDC_DECIMALS));
    const feeUsd = q.totalNetworkFeeWei !== null && ethUsd !== null ? Number(formatUnits(q.totalNetworkFeeWei, 18)) * ethUsd : 0;
    const net = outUsd !== null ? outUsd - feeUsd : Number(formatUnits(q.buyAmount, side === "buy" ? asset.decimals : USDC_DECIMALS));
    return { alt: { provider, buyAmount: q.buyAmount.toString(), netUsd: outUsd !== null ? outUsd - feeUsd : null, latencyMs: r.value.latencyMs, route: q.route.map((f) => f.source).join(", "), best: false, outUsd, estimatedNetworkFeeUsd: q.totalNetworkFeeWei !== null && ethUsd !== null ? feeUsd : null, executablePriceUsd: executablePrice(side, q, asset, ethUsd) }, q, net };
  });
  const ok = scored.filter((x) => x.q !== null).sort((a, b) => b.net - a.net);
  if (ok.length === 0) {
    const errors = scored.map((x) => x.alt.error ?? "").filter(Boolean);
    const liquidity = errors.some((e) => /liquidity|no route|route not found/i.test(e));
    throw new AppError(liquidity ? "ROUTE_UNAVAILABLE" : "PROVIDER_UNAVAILABLE", liquidity ? "No route has enough onchain liquidity for this amount. Try a smaller amount or check back later." : "Trading is temporarily unavailable.", liquidity ? 409 : 503, { providers: errors.join(" | ") });
  }
  ok[0]!.alt.best = true;
  const alternatives = [...ok.map((x) => x.alt), ...scored.filter((x) => x.q === null).map((x) => x.alt)];
  metrics.count(`trade.compare.best.${ok[0]!.alt.provider}`);
  return { best: ok[0]!.q!, alternatives };
}

export class TradeRouter {
  /** Indicative price for the trade sheet while the user edits the amount. */
  async price(req: TradeRequest): Promise<TradeQuoteSummary> {
    const { asset, warnings } = await b20Guard.preTradeCheck({ assetAddress: req.assetAddress, side: req.side, taker: req.taker, recipient: req.recipient, chainId: req.chainId });
    validateAmount(req, asset, asset.oracle?.priceUsd ?? null, req.payWith === "ETH" ? await getEthUsd() : null);
    const intent = buildIntent(req, asset);
    const started = Date.now();
    const { best, alternatives } = await compareProviders(intent, asset, req.side, req.orders !== false, !req.noZeroX);
    metrics.count(`trade.price.${best.provider}`);
    const summary = await summarize(req, asset, best, warnings);
    metrics.count("trade.price.latency", true, String(Date.now() - started));
    return { ...summary, alternatives };
  }

  /** Fresh executable quote for review/submit. Short-lived; the client re-fetches on expiry. */
  async quote(req: TradeRequest): Promise<ExecutableQuoteDTO> {
    if (!req.taker) throw new AppError("WALLET_NOT_CONNECTED", "Connect a wallet to continue.", 400);
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
    const summary = await summarize(req, asset, q, warnings);
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

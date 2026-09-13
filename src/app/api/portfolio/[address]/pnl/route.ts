import { route, json, addressParam } from "@/lib/api";
import { getPortfolioPnl } from "@/services/pnl-service";

/**
 * Cost basis and profit for a wallet, from the trades this app recorded.
 *
 * Public like the rest of the portfolio routes: everything behind it — balances, prices, and
 * transactions the wallet already broadcast — is readable on Base by anyone. The response says
 * plainly how much of the position it can account for, so a holding bought elsewhere never reads
 * as free profit.
 */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "portfolio.pnl", limit: 60, windowMs: 60_000 } }, async (_req, { params }) => {
  const address = await addressParam(params);
  // `no-store`: a CDN copy outlived the trade that changed it, so a buy showed no effect for a minute.
  return json({ pnl: await getPortfolioPnl(address) });
});

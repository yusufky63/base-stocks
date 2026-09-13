import { z } from "zod";
import { route, json, addressParam, parseQuery } from "@/lib/api";
import { getPortfolioCurve, type CurveWindow } from "@/services/portfolio-curve-service";

const querySchema = z.object({ window: z.enum(["1D", "1W", "1M", "3M", "1Y"]).default("1D") });

/**
 * The wallet's current stock holdings, valued back through the Chainlink reference.
 *
 * Deliberately not a replay of the account: buys, sells and gifts are invisible here, and the
 * response is labelled that way in the UI. The daily snapshots at `/history` are the record of
 * what the account was actually worth.
 *
 * The window is what was asked for; the coverage is what the feeds have. One history read reaches
 * back a bounded number of rounds, so a long window comes back shorter than asked, starting at
 * `coverageFrom`, rather than padded with a price nobody published.
 */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "portfolio.curve", limit: 60, windowMs: 60_000 } }, async (req, { params }) => {
  const address = await addressParam(params);
  const { window } = parseQuery(req, querySchema);
  // `no-store`: the holdings behind this change with every trade; a CDN copy outlived them.
  return json({ curve: await getPortfolioCurve(address, window as CurveWindow) });
});

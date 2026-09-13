import { erc20Abi, type Address } from "viem";
import { route, json, addressParam } from "@/lib/api";
import { sessionAddress } from "@/lib/auth/session";
import { countDurableWindow } from "@/lib/rate-limit";
import { metrics } from "@/lib/http";
import { getRepos } from "@/db/repositories";
import { getAssets } from "@/services/b20-asset-service";
import { getActivity } from "@/services/activity-service";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { USDC_ADDRESS } from "@/config/chain";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** First-time wallet registrations one IP may cause in a day. A person looks up a handful; a crawler does not stop. */
const REGISTRATIONS_PER_IP_PER_DAY = 20;
const DAY_MS = 24 * 3600_000;

/**
 * Whether this wallet has any footprint here: an app record, or a balance of USDC or any listed
 * stock. One multicall and two cheap table reads; it decides whether an unauthenticated lookup may
 * put the wallet into the transfer index (a chain scan and an Earn reconciliation).
 */
async function hasFootprint(owner: Address): Promise<boolean> {
  const repos = getRepos();
  const [trades, watchlist] = await Promise.all([repos.trades.listByOwner(owner, 1).catch(() => []), repos.watchlists.list(owner).catch(() => [])]);
  if (trades.length > 0 || watchlist.length > 0) return true;
  try {
    const assets = await getAssets();
    const tokens = [USDC_ADDRESS, ...assets.map((a) => a.address)];
    const balances = await getServerPublicClient().multicall({ contracts: tokens.map((address) => ({ address, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const })), allowFailure: true });
    return balances.some((b) => b.status === "success" && (b.result as bigint) > 0n);
  } catch (err) {
    metrics.count("activity.footprint", false, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * The wallet's activity timeline. Reading is public (the chain is), but the first read of a wallet
 * registers it in the transfer index, which costs a chain scan: that is allowed for the signed-in
 * owner, for a wallet that already has a footprint here, and never more than a few times a day
 * per caller. Anyone else still gets the records and an already-indexed wallet's transfers.
 */
export const GET = route<{ params: Promise<{ address: string }> }>({ rateLimit: { key: "activity", limit: 60, windowMs: 60_000, durable: true } }, async (req, { params }) => {
  const owner = await addressParam(params);
  const me = sessionAddress(req);
  let allowBackfill = !!me && me.toLowerCase() === owner.toLowerCase();
  if (!allowBackfill) {
    const indexed = await getRepos().walletIndex.get(owner).catch(() => null);
    if (!indexed && (await hasFootprint(owner))) {
      const registrations = await countDurableWindow(req, "activity.register", DAY_MS);
      allowBackfill = registrations === null || registrations <= REGISTRATIONS_PER_IP_PER_DAY;
      if (!allowBackfill) metrics.count("activity.register.capped", false);
    }
  }
  const items = await getActivity(owner, { allowBackfill });
  return json({ items, readAt: Date.now() });
});

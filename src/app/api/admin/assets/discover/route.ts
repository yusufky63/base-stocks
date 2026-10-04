import { z } from "zod";
import { route, json, parseBody, requireAdmin, addressSchema } from "@/lib/api";
import { serverEnv } from "@/config/env";
import { syncDiscoveredAssets, loadDiscoveredRegistry, invalidateAssetCaches } from "@/services/b20-asset-service";
import { getRepos } from "@/db/repositories";

/**
 * Admin: recheck Coinbase listings, stored candidates and B20 events. Verified issuer assets
 * with supply, unpaused transfers, DEX liquidity and two-way routes are added automatically.
 */
export const POST = route({ rateLimit: { key: "admin.discover", limit: 5, windowMs: 60_000 } }, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  const status = await syncDiscoveredAssets({ lookbackBlocks: 450_000n });
  const all = await getRepos().discoveredAssets.list();
  return json({ discovered: all.filter((a) => a.eligible), status, all });
});

const verifySchema = z.object({ address: addressSchema, verification: z.enum(["discovered", "verified", "disabled"]) });

export const PATCH = route({ rateLimit: { key: "admin.discover", limit: 20, windowMs: 60_000 } }, async (req) => {
  requireAdmin(req, serverEnv().ADMIN_API_TOKEN);
  const { address, verification } = await parseBody(req, verifySchema);
  await getRepos().discoveredAssets.setVerification(address, verification);
  await loadDiscoveredRegistry(true);
  invalidateAssetCaches();
  return json({ ok: true });
});

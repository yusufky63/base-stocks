import { z } from "zod";
import { route, json, parseQuery } from "@/lib/api";
import { getBasenameAvatar, resolveRecipient, reverseResolve } from "@/services/basename-service";
import { getRepos } from "@/db/repositories";
import type { ResolvedRecipient } from "@/domain/gift";

/**
 * Resolve a Basename or raw address into a checksummed recipient, enriched with what we can
 * verify: the reverse Basename of a raw address (forward-verified), its avatar record, and the
 * BStocks profile when the recipient has signed in here (handle only when the profile is public).
 */
export const GET = route({ rateLimit: { key: "basename.resolve", limit: 120, windowMs: 60_000 } }, async (req) => {
  const { name } = parseQuery(req, z.object({ name: z.string().min(1).max(255) }));
  const base = await resolveRecipient(name);
  if (!base) return json({ input: name, resolved: null }, { cacheSeconds: 30, staleSeconds: 300 });
  const [reverse, profile] = await Promise.all([
    base.basename ? Promise.resolve(base.basename) : reverseResolve(base.address).catch(() => null),
    getRepos().profiles.get(base.address).catch(() => null),
  ]);
  const basename = reverse ?? undefined;
  const avatar = basename ? await getBasenameAvatar(basename).catch(() => null) : null;
  const resolved: ResolvedRecipient = {
    address: base.address,
    basename,
    avatar,
    profile: profile ? { handle: profile.isPublic ? profile.handle : undefined, displayName: profile.isPublic ? profile.displayName : undefined, isPublic: profile.isPublic, memberSince: profile.createdAt } : null,
  };
  return json({ input: name, resolved }, { cacheSeconds: 30, staleSeconds: 300 });
});

import { route, json } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { computeBadges, resolveProfileRef } from "@/services/community-service";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { reverseResolve } from "@/services/basename-service";

/** Serverless budget: upstream providers and the model may take longer than the 10 s default. */
export const maxDuration = 60;

/** Public profile by handle or address: allocation (percent), badges, published baskets. */
/** Each call reads a wallet from the chain, so the limit is sized for a person browsing, not a crawler. */
export const GET = route<{ params: Promise<{ ref: string }> }>({ rateLimit: { key: "profiles.read", limit: 30, windowMs: 60_000, durable: true } }, async (_req, { params }) => {
  const { ref } = await params;
  const address = await resolveProfileRef(ref);
  if (!address) throw new AppError("NOT_FOUND", "Profile not found", 404);
  const repos = getRepos();
  const [profile, baskets, badges, basename, snapshot] = await Promise.all([
    repos.profiles.get(address),
    repos.baskets.listByOwner(address),
    computeBadges(address),
    reverseResolve(address).catch(() => null),
    getPortfolioSnapshot(address).catch(() => null),
  ]);
  const isPublic = profile?.isPublic ?? true;
  const allocation = isPublic && snapshot ? snapshot.holdings.map((h) => ({ assetAddress: h.assetAddress, symbol: h.underlying, weightBps: h.currentWeightBps })) : [];
  return json({
    address,
    profile: profile ?? { address, isPublic: true, createdAt: 0, updatedAt: 0 },
    basename,
    badges,
    baskets,
    allocation,
    positions: isPublic ? (snapshot?.holdings.length ?? 0) : null,
  });
});

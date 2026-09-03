import { route, json } from "@/lib/api";
import { getRepos } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { computeBadges, resolveProfileRef } from "@/services/community-service";
import { getPortfolioSnapshot } from "@/services/portfolio-service";
import { reverseResolve } from "@/services/basename-service";

/** Public profile by handle or address: allocation (percent), badges, published baskets, referral stats. */
export const GET = route<{ params: Promise<{ ref: string }> }>({ rateLimit: { key: "profiles.read", limit: 120, windowMs: 60_000 } }, async (_req, { params }) => {
  const { ref } = await params;
  const address = await resolveProfileRef(ref);
  if (!address) throw new AppError("NOT_FOUND", "Profile not found", 404);
  const repos = getRepos();
  const [profile, baskets, badges, basename, referral, snapshot] = await Promise.all([
    repos.profiles.get(address),
    repos.baskets.listByOwner(address),
    computeBadges(address),
    reverseResolve(address).catch(() => null),
    repos.referrals.statsFor(address),
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
    referral,
    allocation,
    positions: isPublic ? (snapshot?.holdings.length ?? 0) : null,
  });
});

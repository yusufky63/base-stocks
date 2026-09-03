import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { updateProfile } from "@/services/community-service";

const patchSchema = z.object({
  handle: z.string().max(24).optional(),
  displayName: z.string().max(40).optional(),
  bio: z.string().max(200).optional(),
  isPublic: z.boolean().optional(),
});

export const GET = route({}, async (req) => {
  const address = requireSession(req);
  const repos = getRepos();
  const profile = await repos.profiles.get(address);
  return json({ profile: profile ?? { address, isPublic: true, createdAt: 0, updatedAt: 0 } });
});

export const PUT = route({ rateLimit: { key: "profiles.write", limit: 20, windowMs: 60_000 } }, async (req) => {
  const address = requireSession(req);
  const body = await parseBody(req, patchSchema);
  return json({ profile: await updateProfile(address, body) });
});

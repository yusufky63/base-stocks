import { z } from "zod";
import { route, json, parseQuery, addressSchema } from "@/lib/api";
import { reverseResolve, getBasenameAvatar } from "@/services/basename-service";

export const GET = route({ rateLimit: { key: "basename.reverse", limit: 240, windowMs: 60_000 } }, async (req) => {
  const { address } = parseQuery(req, z.object({ address: addressSchema }));
  const name = await reverseResolve(address);
  const avatar = name ? await getBasenameAvatar(name) : null;
  return json({ address, name, avatar }, { cacheSeconds: 60, staleSeconds: 600 });
});

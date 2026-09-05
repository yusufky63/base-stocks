import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { recordError } from "@/lib/error-sink";

const bodySchema = z.object({
  message: z.string().min(1).max(400),
  digest: z.string().max(64).optional(),
  path: z.string().max(200).optional(),
  stack: z.string().max(2_000).optional(),
  fatal: z.boolean().optional(),
});

/** The browser's error boundaries report here. Rate-limited; the payload is a message and a path, never who. */
export const POST = route({ rateLimit: { key: "errors.report", limit: 10, windowMs: 60_000 } }, async (req) => {
  const body = await parseBody(req, bodySchema);
  await recordError({ source: "client", route: body.path, message: body.message, stack: body.stack, digest: body.digest, meta: body.fatal ? { fatal: true } : undefined });
  return json({ ok: true }, { status: 202 });
});

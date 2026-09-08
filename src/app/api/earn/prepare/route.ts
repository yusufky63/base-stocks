import { z } from "zod";
import { assertTradingAllowed } from "@/lib/geo";
import { route, json, parseBody, addressSchema } from "@/lib/api";
import { prepareEarn } from "@/services/earn-opportunity-service";

const bodySchema = z.object({
  opportunityId: z.string().min(6).max(80),
  user: addressSchema,
  amount: z.union([z.literal("max"), z.string().regex(/^\d+$/)]),
  action: z.enum(["deposit", "withdraw"]),
});

/** Deposit / withdraw calls for an Earn opportunity. Never signs or sends; the wallet does. */
export const POST = route({ rateLimit: { key: "earn.prepare", limit: 60, windowMs: 60_000 } }, async (req) => {
  assertTradingAllowed(req);
  const body = await parseBody(req, bodySchema);
  const exec = await prepareEarn({ opportunityId: body.opportunityId, user: body.user, amount: body.amount === "max" ? "max" : BigInt(body.amount), action: body.action });
  return json({ ...exec, calls: exec.calls.map((c) => ({ ...c, value: c.value.toString() })) });
});

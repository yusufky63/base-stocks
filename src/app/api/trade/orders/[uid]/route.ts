import { z } from "zod";
import { route, json, parseBody } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { cancelOrders, getOrder } from "@/providers/trading/cow/adapter";

const uidSchema = z.string().regex(/^0x[0-9a-fA-F]{112}$/, "Invalid order uid");

/** Live status of one order (polled after submission; never cached). */
export const GET = route<{ params: Promise<{ uid: string }> }>({ rateLimit: { key: "orders.read", limit: 240, windowMs: 60_000 } }, async (_req, { params }) => {
  const { uid } = await params;
  const parsed = uidSchema.safeParse(uid);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "Invalid order uid", 400);
  return json({ order: await getOrder(parsed.data) });
});

/** Offchain cancellation (EOA signature). Smart wallets invalidate onchain from the client instead. */
export const DELETE = route<{ params: Promise<{ uid: string }> }>({ rateLimit: { key: "orders.submit", limit: 20, windowMs: 60_000 } }, async (req, { params }) => {
  const { uid } = await params;
  const parsed = uidSchema.safeParse(uid);
  if (!parsed.success) throw new AppError("BAD_REQUEST", "Invalid order uid", 400);
  const body = await parseBody(req, z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]+$/), signingScheme: z.enum(["eip712", "ethsign"]) }));
  await cancelOrders([parsed.data], body.signature as `0x${string}`, body.signingScheme);
  return json({ ok: true });
});

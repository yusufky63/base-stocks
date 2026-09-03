import { route, json, hashSchema } from "@/lib/api";
import { confirmationService } from "@/services/confirmation-service";
import { AppError } from "@/lib/errors";
import type { Hash } from "viem";

/** Submitted → Preconfirmed → Confirmed, with normal receipt fallback. */
export const GET = route<{ params: Promise<{ hash: string }> }>({ rateLimit: { key: "tx.status", limit: 300, windowMs: 60_000 } }, async (_req, { params }) => {
  const { hash } = await params;
  if (!hashSchema.safeParse(hash).success) throw new AppError("BAD_REQUEST", "Invalid transaction hash", 400);
  const status = await confirmationService.getStatus(hash as Hash);
  return json(status);
});

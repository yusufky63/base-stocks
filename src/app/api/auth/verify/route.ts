import { z } from "zod";
import { parseSiweMessage } from "viem/siwe";
import { route, parseBody } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { normalizeAddress } from "@/lib/address";
import { BASE_CHAIN_ID } from "@/config/chain";
import { clearCookieHeader, cookieHeader, encodeSession, NONCE_COOKIE, readCookie, REF_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";
import { getRepos } from "@/db/repositories";
import { metrics } from "@/lib/http";

const bodySchema = z.object({
  message: z.string().min(20).max(4000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

/**
 * Verify a SIWE message (EOA signatures and ERC-1271 / ERC-6492 smart-account signatures such
 * as Base Account) and set the session cookie. Also links a pending referral cookie.
 */
export const POST = route({ rateLimit: { key: "auth.verify", limit: 20, windowMs: 60_000 } }, async (req) => {
  const { message, signature } = await parseBody(req, bodySchema);
  const parsed = parseSiweMessage(message);
  const nonce = readCookie(req, NONCE_COOKIE);
  if (!parsed.address || !parsed.nonce || !nonce || parsed.nonce !== nonce) throw new AppError("UNAUTHORIZED", "Sign-in expired. Please try again.", 401);
  if (parsed.chainId !== undefined && parsed.chainId !== BASE_CHAIN_ID) throw new AppError("WRONG_NETWORK", "Sign in on Base.", 400);
  const host = req.headers.get("host") ?? "";
  if (parsed.domain && host && parsed.domain !== host) throw new AppError("UNAUTHORIZED", "Sign-in domain mismatch.", 401);

  const client = getServerPublicClient();
  const ok = await client.verifySiweMessage({ message, signature: signature as `0x${string}`, nonce }).catch((err) => {
    metrics.count("auth.verify", false, err instanceof Error ? err.message : String(err));
    return false;
  });
  if (!ok) throw new AppError("UNAUTHORIZED", "Signature could not be verified.", 401);

  const address = normalizeAddress(parsed.address);
  const ref = readCookie(req, REF_COOKIE);
  if (ref && /^0x[0-9a-fA-F]{40}$/.test(ref) && ref.toLowerCase() !== address.toLowerCase()) {
    await getRepos().referrals.claim(address, normalizeAddress(ref)).catch(() => undefined);
  }
  await getRepos().profiles.touch(address).catch(() => undefined);

  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, encodeSession(address), 7 * 24 * 3600));
  headers.append("set-cookie", clearCookieHeader(NONCE_COOKIE));
  if (ref) headers.append("set-cookie", clearCookieHeader(REF_COOKIE));
  return new Response(JSON.stringify({ address }), { status: 200, headers });
});

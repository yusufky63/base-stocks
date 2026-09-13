import { privateKeyToAccount } from "viem/accounts";
import { parseSignature, type Address, type Hex } from "viem";
import { serverEnv } from "@/config/env";
import { POOL_TICKET_TYPES, poolTicketDomain, type ClaimTicket } from "@/lib/pool";
import { AppError } from "@/lib/errors";

/**
 * The campaign signer behind quest-gated pools. Server-only — importing this from a client
 * component would be a build error, and the key is never sent anywhere.
 *
 * A ticket is short-lived on purpose: if one ever leaks it is useless within the hour, and it can
 * only ever pay the address it names.
 */
export const TICKET_TTL_SECONDS = 15 * 60;

let cached: ReturnType<typeof privateKeyToAccount> | null | undefined;

function gateAccount() {
  if (cached !== undefined) return cached;
  if (typeof window !== "undefined") throw new Error("The pool gate signer must not be used in the browser");
  const key = serverEnv().POOL_GATE_SIGNER_KEY;
  cached = key ? privateKeyToAccount(key as Hex) : null;
  return cached;
}

/** Address campaigns must store as their `gate`, or null when no signer is configured. */
export function gateSignerAddress(): Address | null {
  return gateAccount()?.address ?? null;
}

export function isGateSignerConfigured(): boolean {
  return gateAccount() !== null;
}

/**
 * Signs a claim ticket for `recipient`. Callers must verify the quests first. `contract` is the
 * pool's own (`poolContractOf`): the domain binds the ticket to one deployment, so a ticket
 * signed for the current contract would be refused by the one an older pool lives in.
 */
export async function issueTicket(contract: Address, poolId: Hex, recipient: Address): Promise<ClaimTicket> {
  const account = gateAccount();
  if (!account) throw new AppError("POOL_UNAVAILABLE", "Quest-gated pools are not enabled on this deployment.", 503);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS);
  const signature = await account.signTypedData({
    domain: poolTicketDomain(contract),
    types: POOL_TICKET_TYPES,
    primaryType: "Ticket",
    message: { poolId, recipient, deadline },
  });
  const { v, r, s } = parseSignature(signature);
  return { deadline: deadline.toString(), v: Number(v ?? 27n), r, s };
}

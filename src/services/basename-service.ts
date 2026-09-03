import { namehash, parseAbi, type Address, zeroAddress } from "viem";
import { getServerPublicClient } from "@/lib/viem/server-client";
import { BASENAMES_L2_RESOLVER_ADDRESS, BASENAMES_REVERSE_COIN_TYPE_HEX } from "@/config/chain";
import { cached, TTL } from "@/lib/cache";
import { looksLikeBasename, normalizeAddress } from "@/lib/address";
import { metrics } from "@/lib/http";

/**
 * Basenames resolution directly against the Base L2 resolver.
 * - forward: namehash(name) → addr(node)
 * - reverse: namehash(`<addr>.<coinType>.reverse`) → name(node), then forward-verified.
 * Docs: https://docs.base.org/sdks/base-account/framework-integrations/wagmi/basenames
 * Contracts: https://github.com/base/basenames
 */
const l2ResolverAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
  "function name(bytes32 node) view returns (string)",
  "function text(bytes32 node, string key) view returns (string)",
]);

export function reverseNode(address: Address): `0x${string}` {
  const label = address.slice(2).toLowerCase();
  return namehash(`${label}.${BASENAMES_REVERSE_COIN_TYPE_HEX}.reverse`);
}

export async function resolveBasename(name: string): Promise<Address | null> {
  const n = name.trim().toLowerCase();
  if (!looksLikeBasename(n)) return null;
  return cached(`basename:fwd:${n}`, TTL.basename, async () => {
    try {
      const addr = await getServerPublicClient().readContract({
        address: BASENAMES_L2_RESOLVER_ADDRESS,
        abi: l2ResolverAbi,
        functionName: "addr",
        args: [namehash(n)],
      });
      return addr && addr !== zeroAddress ? normalizeAddress(addr) : null;
    } catch (err) {
      metrics.count("basename.resolve", false, err instanceof Error ? err.message : String(err));
      return null;
    }
  });
}

export async function reverseResolve(address: Address): Promise<string | null> {
  const a = normalizeAddress(address);
  return cached(`basename:rev:${a.toLowerCase()}`, TTL.basename, async () => {
    try {
      const name = await getServerPublicClient().readContract({
        address: BASENAMES_L2_RESOLVER_ADDRESS,
        abi: l2ResolverAbi,
        functionName: "name",
        args: [reverseNode(a)],
      });
      if (!name) return null;
      // Forward-verify to avoid spoofed reverse records.
      const fwd = await resolveBasename(name);
      return fwd && fwd.toLowerCase() === a.toLowerCase() ? name : null;
    } catch (err) {
      metrics.count("basename.reverse", false, err instanceof Error ? err.message : String(err));
      return null;
    }
  });
}

export async function getBasenameAvatar(name: string): Promise<string | null> {
  const n = name.trim().toLowerCase();
  if (!looksLikeBasename(n)) return null;
  return cached(`basename:avatar:${n}`, TTL.basename, async () => {
    try {
      const v = await getServerPublicClient().readContract({ address: BASENAMES_L2_RESOLVER_ADDRESS, abi: l2ResolverAbi, functionName: "text", args: [namehash(n), "avatar"] });
      return v || null;
    } catch {
      return null;
    }
  });
}

/** Resolve user input (raw address or Basename) into a checksummed address. */
export async function resolveRecipient(input: string): Promise<{ address: Address; basename?: string } | null> {
  const v = input.trim();
  if (!v) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return { address: normalizeAddress(v) };
  if (looksLikeBasename(v)) {
    const a = await resolveBasename(v);
    return a ? { address: a, basename: v.toLowerCase() } : null;
  }
  return null;
}

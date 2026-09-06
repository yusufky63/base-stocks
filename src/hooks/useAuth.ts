"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { createSiweMessage } from "viem/siwe";
import { apiGet, apiPost, apiDelete, ApiError } from "@/lib/client-api";
import { BASE_CHAIN_ID } from "@/config/chain";

/**
 * Sign-In with Ethereum on demand. Never triggered on page load; call `ensureSignedIn()` right
 * before an action that needs ownership. Works with Base Account (ERC-6492/1271) and EOAs.
 */
export function useAuth() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const qc = useQueryClient();

  const session = useQuery({
    queryKey: ["auth", "session"],
    queryFn: () => apiGet<{ address: `0x${string}` | null }>("/api/auth/session"),
    staleTime: 60_000,
  });

  const signedInAs = session.data?.address ?? null;
  const isSignedIn = !!signedInAs && !!address && signedInAs.toLowerCase() === address.toLowerCase();

  const signIn = useMutation({
    mutationFn: async () => {
      if (!address) throw new ApiError("WALLET_NOT_CONNECTED", "Connect a wallet first.", 400);
      const { nonce } = await apiGet<{ nonce: string }>("/api/auth/nonce");
      const message = createSiweMessage({
        address,
        chainId: BASE_CHAIN_ID,
        domain: window.location.host,
        uri: window.location.origin,
        nonce,
        version: "1",
        statement: "Sign in to BaseStocks. This signature proves you own this wallet. It costs nothing and does not approve any transaction.",
      });
      const signature = await signMessageAsync({ message });
      return apiPost<{ address: `0x${string}` }>("/api/auth/verify", { message, signature });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "session"] }),
  });

  const signOut = useMutation({
    mutationFn: () => apiDelete("/api/auth/session", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "session"] }),
  });

  const ensureSignedIn = useCallback(async () => {
    if (isSignedIn) return true;
    await signIn.mutateAsync();
    return true;
  }, [isSignedIn, signIn]);

  return { address, isConnected, isSignedIn, signedInAs, signIn: signIn.mutateAsync, signingIn: signIn.isPending, signOut: signOut.mutateAsync, ensureSignedIn, error: signIn.error };
}

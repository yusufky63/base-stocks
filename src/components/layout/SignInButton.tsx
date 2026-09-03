"use client";

import { LogIn } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/primitives";
import { ConnectButton } from "./ConnectButton";

/** Sign-in gate for actions that need proof of ownership (publishing, voting, profiles). */
export function SignInButton({ size = "sm", full, label = "Sign in with wallet" }: { size?: "sm" | "md" | "lg"; full?: boolean; label?: string }) {
  const auth = useAuth();
  if (!auth.isConnected) return <ConnectButton size={size} full={full} />;
  if (auth.isSignedIn) return null;
  return (
    <Button size={size} full={full} variant="secondary" loading={auth.signingIn} onClick={() => auth.signIn().catch(() => undefined)}>
      <LogIn size={14} strokeWidth={1.75} /> {label}
    </Button>
  );
}

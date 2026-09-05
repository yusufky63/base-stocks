"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, Module, ModuleHeader } from "@/components/ui/primitives";
import { ErrorBanner } from "@/components/common/display";

/**
 * What a visitor sees when a page throws: the app's own panel, a retry, and a way home — not the
 * framework's default screen. The error is also reported so it is seen on the admin page; the
 * report carries no wallet address and nothing the visitor typed.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void fetch("/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: error.message?.slice(0, 400) || "Unknown error", digest: error.digest, path: typeof window !== "undefined" ? window.location.pathname : undefined, stack: error.stack?.slice(0, 2000) }),
      keepalive: true,
    }).catch(() => undefined);
  }, [error]);

  return (
    <div className="max-w-[640px] mx-auto py-8">
      <Module>
        <ModuleHeader title="Something went wrong" />
        <div className="p-4 flex flex-col gap-4">
          <ErrorBanner message="This page hit an error and stopped. Nothing was sent from your wallet; retrying is safe." detail={error.digest ? `ref ${error.digest}` : undefined} />
          <p className="text-[13px] text-ink-secondary">If it keeps happening, the status page shows whether a data provider is down. The error has been reported.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => reset()}>Try again</Button>
            <Link href="/" className="inline-flex items-center justify-center h-11 px-4 rounded-[6px] border border-line-strong text-[15px] font-medium hover:bg-surface">
              Home
            </Link>
            <Link href="/status" className="inline-flex items-center justify-center h-11 px-4 rounded-[6px] text-[15px] font-medium text-ink-secondary hover:text-ink">
              Status
            </Link>
          </div>
        </div>
      </Module>
    </div>
  );
}

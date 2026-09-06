"use client";

import { useEffect } from "react";

/**
 * The last line: shown only when the root layout itself fails, so it carries its own html and
 * body and depends on nothing but inline styles. Reports the error like the page boundary does.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void fetch("/api/errors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: error.message?.slice(0, 400) || "Unknown error", digest: error.digest, path: typeof window !== "undefined" ? window.location.pathname : undefined, stack: error.stack?.slice(0, 2000), fatal: true }),
      keepalive: true,
    }).catch(() => undefined);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0a0b0d", color: "#fff", minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ maxWidth: 480, border: "1px solid #2b2e36", borderRadius: 8, padding: 24, background: "#111318" }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "#8a90a0", marginBottom: 8 }}>BaseStocks</div>
          <h1 style={{ fontSize: 22, margin: "0 0 8px", letterSpacing: "-0.02em" }}>The app could not load</h1>
          <p style={{ margin: "0 0 16px", color: "#b1b7c3", fontSize: 14, lineHeight: 1.5 }}>Nothing was sent from your wallet. Reload the page; if it keeps failing, the error has been reported{error.digest ? ` (ref ${error.digest})` : ""}.</p>
          <button type="button" onClick={() => reset()} style={{ background: "#0370fd", color: "#fff", border: 0, borderRadius: 6, padding: "10px 16px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}

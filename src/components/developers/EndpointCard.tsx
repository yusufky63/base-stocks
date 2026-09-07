"use client";

import { useState } from "react";
import { Check, Copy, Play } from "lucide-react";
import type { V1Endpoint } from "@/lib/api-v1/catalog";
import { Badge, Button, Module, cx } from "@/components/ui/primitives";

/**
 * One endpoint, with a button that actually calls it.
 *
 * Documentation that shows a canned example ages into fiction. This runs the request against the
 * deployment the reader is on and prints what came back, so the page cannot describe a response
 * the API no longer returns.
 */
export function EndpointCard({ endpoint }: { endpoint: V1Endpoint }) {
  const [body, setBody] = useState<string | null>(null);
  const [status, setStatus] = useState<{ code: number; ms: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setRunning(true);
    setBody(null);
    const started = performance.now();
    try {
      const res = await fetch(endpoint.example, { headers: { accept: "application/json" } });
      const text = await res.text();
      setStatus({ code: res.status, ms: Math.round(performance.now() - started) });
      // Pretty-print when it parses; show it raw when it does not, rather than swallowing the body.
      try {
        setBody(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        setBody(text);
      }
    } catch (err) {
      setStatus({ code: 0, ms: Math.round(performance.now() - started) });
      setBody(err instanceof Error ? err.message : "Request failed");
    } finally {
      setRunning(false);
    }
  };

  const curl = `curl -s "https://basestocks.finance${endpoint.example}"`;
  const copy = () => {
    void navigator.clipboard?.writeText(curl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <Module>
      <div className="px-4 py-3 border-b border-line flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] px-1.5 h-5 inline-flex items-center rounded-[4px] border border-line text-ink-muted shrink-0">GET</span>
          <code className="font-mono text-[13px] text-ink truncate">{endpoint.path}</code>
        </div>
        {endpoint.paid ? <Badge tone="primary">0.10 USDC</Badge> : <Badge tone="positive">Free</Badge>}
      </div>

      <div className="p-4 flex flex-col gap-3">
        <p className="text-[13px] text-ink-secondary leading-relaxed">{endpoint.summary}</p>

        {endpoint.params && endpoint.params.length > 0 && (
          <div className="border border-line rounded-[6px] overflow-hidden">
            {endpoint.params.map((p) => (
              <div key={p.name} className="grid grid-cols-[110px_1fr] gap-x-3 px-3 py-2 border-b border-line last:border-b-0">
                <div className="font-mono text-[11px] text-ink">
                  {p.name}
                  {!p.required && <span className="text-ink-muted"> ?</span>}
                </div>
                <div className="text-[12px] text-ink-secondary">{p.description}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={() => void run()} loading={running}>
            <Play size={13} strokeWidth={2} /> Run it
          </Button>
          <button type="button" onClick={copy} className="h-9 px-3 inline-flex items-center gap-1.5 rounded-[6px] border border-line text-[12px] text-ink-secondary hover:text-ink hover:border-line-strong transition-fast">
            {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
            {copied ? "Copied" : "Copy curl"}
          </button>
          {!endpoint.paid && <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">cached {endpoint.cacheSeconds}s</span>}
        </div>

        {status && (
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className={cx("px-1.5 h-5 inline-flex items-center rounded-[4px]", status.code >= 200 && status.code < 300 ? "bg-positive-soft text-positive-fg" : status.code === 402 ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger-fg")}>
              {status.code || "ERR"}
            </span>
            <span className="text-ink-muted">{status.ms} ms</span>
          </div>
        )}

        {body && (
          <pre className="max-h-72 overflow-auto rounded-[6px] border border-line bg-surface p-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre">{body.length > 12_000 ? `${body.slice(0, 12_000)}\n… truncated for display` : body}</pre>
        )}
      </div>
    </Module>
  );
}

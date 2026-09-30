"use client";

import { useMemo, useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { PRO_PRICE_USD, type V1Endpoint, type V1Param } from "@/lib/api-v1/catalog";
import { buildRequest, curlOf, exampleValues } from "@/lib/api-v1/try";
import { eligibilityHeaders } from "@/lib/eligibility-store";
import { Badge, Button, Module, cx } from "@/components/ui/primitives";
import { CopyBlock } from "./CopyBlock";

/** `integer 1–30 · default 10`, `ecosystem | market`: what a value may be, in one cell. */
function typeText(p: V1Param): string {
  const parts = [p.type === "enum" ? (p.enum ?? []).join(" | ") : (p.type ?? "string")];
  if (p.min !== undefined || p.max !== undefined) parts.push(`${p.min ?? "…"}–${p.max ?? "…"}`);
  if (p.default) parts.push(`default ${p.default}`);
  return parts.join(" · ");
}

type Result = { code: number; ms: number; body: string };

/**
 * One endpoint: what it does, what it takes, what it answers, and a request that actually runs.
 *
 * Documentation that shows a canned example ages into fiction. The form starts from the endpoint's
 * example and sends exactly the request its curl line shows, against the deployment the reader is
 * on, so the page cannot describe a response the API no longer returns.
 */
export function EndpointCard({ endpoint, base }: { endpoint: V1Endpoint; base: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => exampleValues(endpoint));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const request = useMemo(() => buildRequest(endpoint, values), [endpoint, values]);
  const params = endpoint.params ?? [];
  const missing = params.some((p) => p.required && !(values[p.name] ?? "").trim());

  const run = async () => {
    setRunning(true);
    setResult(null);
    const started = performance.now();
    try {
      // The answer this browser gave the eligibility question counts here as it does on the site.
      const res = await fetch(request.url, {
        method: request.method,
        headers: { accept: "application/json", ...request.headers, ...(endpoint.eligibility ? eligibilityHeaders() : {}) },
        ...(request.body ? { body: request.body } : {}),
      });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON: shown as it came */
      }
      setResult({ code: res.status, ms: Math.round(performance.now() - started), body });
    } catch (err) {
      setResult({ code: 0, ms: Math.round(performance.now() - started), body: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Module id={endpoint.id} className="scroll-mt-header">
      <div className="px-4 py-3 border-b border-line flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={cx("font-mono text-[11px] uppercase tracking-[0.08em] px-1.5 h-5 inline-flex items-center rounded-[4px] border shrink-0", endpoint.method === "POST" ? "border-primary text-primary bg-primary-soft" : "border-line text-ink-muted")}>
          {endpoint.method}
        </span>
        <code className="font-mono text-[13px] text-ink break-all">{endpoint.path}</code>
        <span className="flex flex-wrap items-center gap-1.5 md:ml-auto">
          {endpoint.paid ? <Badge tone="primary">{PRO_PRICE_USD.replace("$", "")} USDC</Badge> : <Badge tone="positive">Free</Badge>}
          {endpoint.cacheSeconds > 0 && <Badge>cached {endpoint.cacheSeconds}s</Badge>}
          {endpoint.limitPerMinute && <Badge>{endpoint.limitPerMinute}/min</Badge>}
          {endpoint.eligibility && <Badge tone="warning">eligibility</Badge>}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-4 min-w-0">
        <p className="text-[14px] text-ink-secondary leading-relaxed max-w-[80ch]">{endpoint.summary}</p>

        {params.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[540px] border-collapse">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted border-b border-line">
                  <th className="py-2 pr-3 font-normal">Name</th>
                  <th className="py-2 pr-3 font-normal">In</th>
                  <th className="py-2 pr-3 font-normal">Type</th>
                  <th className="py-2 font-normal">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {params.map((p) => (
                  <tr key={p.name} className="align-top">
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink whitespace-nowrap">
                      {p.name}
                      {p.required && <span className="text-danger-fg"> *</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink-muted">{p.in}</td>
                    <td className="py-2 pr-3 font-mono text-[12px] text-ink-secondary">{typeText(p)}</td>
                    <td className="py-2 text-[13px] text-ink-secondary">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <dl className="grid grid-cols-1 md:grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted pt-0.5">Returns</dt>
          <dd className="font-mono text-[12px] text-ink break-words">data = {endpoint.returns}</dd>
          {endpoint.errors.length > 0 && (
            <>
              <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted pt-0.5">Errors</dt>
              <dd className="flex flex-wrap gap-1.5">
                {endpoint.errors.map((e) => (
                  <code key={e} className="font-mono text-[11px] text-ink-secondary border border-line rounded-[4px] px-1.5 py-0.5">
                    {e}
                  </code>
                ))}
              </dd>
            </>
          )}
        </dl>

        <div className="flex flex-col gap-3 border border-line rounded-[8px] p-3 bg-surface">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Try it</span>
          {params.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {params.map((p) => (
                <label key={p.name} className="flex flex-col gap-1 min-w-0">
                  <span className="font-mono text-[12px] text-ink">
                    {p.name}
                    {p.required && <span className="text-danger-fg"> *</span>} <span className="text-ink-muted">{p.in}</span>
                  </span>
                  {p.type === "enum" || p.type === "boolean" ? (
                    <select
                      value={values[p.name] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                      className="h-10 min-w-0 rounded-[6px] border border-line-strong bg-canvas px-2.5 font-mono text-[13px] text-ink outline-none focus:border-primary"
                    >
                      <option value="">{p.required ? "choose" : "not set"}</option>
                      {(p.type === "boolean" ? ["true", "false"] : (p.enum ?? [])).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={values[p.name] ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                      placeholder={p.default ? `default ${p.default}` : (p.type ?? "string")}
                      spellCheck={false}
                      autoComplete="off"
                      className="h-10 min-w-0 rounded-[6px] border border-line-strong bg-canvas px-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-primary"
                    />
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void run()} loading={running} disabled={missing}>
              <Play size={13} strokeWidth={2} /> Send request
            </Button>
            {params.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => { setValues(exampleValues(endpoint)); setResult(null); }}>
                <RotateCcw size={13} strokeWidth={1.75} /> Reset
              </Button>
            )}
            {missing && <span className="text-[12px] text-ink-muted">Fill in the fields marked *.</span>}
          </div>
          <CopyBlock label="curl" code={curlOf(buildRequest(endpoint, values, base))} />
          {result && (
            <div className="flex flex-col gap-2" aria-live="polite">
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className={cx("px-1.5 h-5 inline-flex items-center rounded-[4px]", result.code >= 200 && result.code < 300 ? "bg-positive-soft text-positive-fg" : result.code === 402 ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger-fg")}>
                  {result.code || "ERR"}
                </span>
                <span className="text-ink-muted">{result.ms} ms</span>
                {result.code === 402 && <span className="text-ink-secondary">payment required: the requirements are in the payment-required header</span>}
              </div>
              <pre className="max-h-80 overflow-auto rounded-[6px] border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-ink whitespace-pre">
                {result.body.length > 12_000 ? `${result.body.slice(0, 12_000)}\n… truncated for display` : result.body}
              </pre>
            </div>
          )}
        </div>
      </div>
    </Module>
  );
}

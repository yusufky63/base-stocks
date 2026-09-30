"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** A code sample with a copy button: curl lines, the quick start, the trade example. */
export function CopyBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  };
  return (
    <div className="min-w-0 border border-line rounded-[6px] overflow-hidden">
      <div className="flex items-center justify-between gap-2 h-9 px-3 border-b border-line bg-surface">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 h-7 px-2 rounded-[6px] text-[12px] text-ink-secondary hover:text-ink transition-fast">
          {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto font-mono text-[12px] leading-relaxed text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}

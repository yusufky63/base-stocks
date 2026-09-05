"use client";

import type { PortfolioExecution } from "@/domain/portfolio";
import { formatUsd } from "@/lib/format";
import { Badge, Button, cx } from "@/components/ui/primitives";
import { InfoBanner, TxLink } from "@/components/common/display";

const STEP_COPY: Record<string, string> = {
  pending: "Waiting",
  quoted: "Quote received · confirm in wallet",
  submitted: "Submitted to Base…",
  confirmed: "Confirmed",
  failed: "Not completed",
};

interface Props {
  execution: PortfolioExecution;
  currentStepId: string | null;
  running: boolean;
  summary: { completed: number; total: number; failedSymbols: string[] };
  onRetry: () => void;
  onClose: () => void;
  verb?: string;
}

/** Honest multi-leg progress: "3 of 4 completed", per-leg status, retry for failed legs only. */
export function ExecutionProgress({ execution, currentStepId, running, summary, onRetry, onClose, verb = "purchases" }: Props) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="flex items-center justify-between">
        <div className="display-medium text-[20px]">
          {summary.completed} of {summary.total} {verb} completed
        </div>
        <Badge tone={execution.status === "COMPLETE" ? "positive" : execution.status === "PARTIALLY_FILLED" || execution.status === "FAILED" ? "danger" : "primary"}>{execution.status.replace("_", " ")}</Badge>
      </div>
      <ul className="border border-line rounded-[8px] overflow-hidden">
        {execution.steps.map((s) => (
          <li key={s.id} className={cx("flex items-center justify-between gap-3 px-3 py-2.5 border-b border-line last:border-b-0", currentStepId === s.id && "bg-primary-soft")}>
            <div className="min-w-0">
              <div className="font-medium text-[14px]">
                <span className="font-mono text-[11px] uppercase text-ink-muted mr-2">{s.side ?? "buy"}</span>
                {s.symbol.replace(/c$/, "")} <span className="text-ink-secondary font-normal">· {formatUsd(s.targetUsd)}</span>
              </div>
              <div className={cx("text-[12px]", s.status === "failed" ? "text-danger-fg" : "text-ink-muted")}>
                {STEP_COPY[s.status]}
                {s.errorMessage ? ` — ${s.errorMessage}` : ""}
              </div>
              {s.txHash && (
                <div className="text-[12px]">
                  <TxLink hash={s.txHash} />
                </div>
              )}
            </div>
            <Badge tone={s.status === "confirmed" ? "positive" : s.status === "failed" ? "danger" : s.status === "pending" ? "neutral" : "primary"}>{s.status}</Badge>
          </li>
        ))}
      </ul>
      {summary.failedSymbols.length > 0 && !running && (
        <InfoBanner tone="warning">{summary.failedSymbols.map((s) => s.replace(/c$/, "")).join(", ")} could not be completed. Completed legs are already settled in your wallet.</InfoBanner>
      )}
      <div className="flex gap-2">
        {summary.failedSymbols.length > 0 && !running && (
          <Button full onClick={onRetry}>
            Retry {summary.failedSymbols.map((s) => s.replace(/c$/, "")).join(", ")}
          </Button>
        )}
        {!running && (
          <Button variant="secondary" full onClick={onClose}>
            {execution.status === "COMPLETE" ? "Done" : "Close"}
          </Button>
        )}
      </div>
    </div>
  );
}

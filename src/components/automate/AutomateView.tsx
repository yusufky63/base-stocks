"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PortfolioTemplate } from "@/lib/client-api";
import type { AutomationDraft } from "@/lib/client-api";
import { useTemplates } from "@/hooks/queries";
import { useAutomation } from "@/hooks/useAutomation";
import { parseAutomateLegs } from "@/lib/automate-link";
import { formatUsd, timeAgo } from "@/lib/format";
import { Module, PageTitle, cx } from "@/components/ui/primitives";
import { PlanList } from "./PlanList";
import { PlanWizard, type WizardSeed } from "./PlanWizard";
import { AutoInvestExplainer } from "./AutoInvestExplainer";
import { AiRuleDraft } from "./AiRuleDraft";

type Pane = "plan" | "assistant";

/**
 * Automate: recurring purchases that run by themselves (AutoInvest contract + keeper) or wait for a
 * confirmation per run. Building a plan is the main job, so it takes the wide column; the plans you
 * already have sit beside it with one Manage button each.
 */
export function AutomateView({ initialTemplates, embedded = false }: { initialTemplates?: PortfolioTemplate[]; embedded?: boolean }) {
  const { data: templates } = useTemplates(initialTemplates);
  const automation = useAutomation();
  const search = useSearchParams();
  const [pane, setPane] = useState<Pane>("plan");
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const seed = useMemo<WizardSeed | undefined>(() => {
    const legs = parseAutomateLegs(search.get("legs"));
    return legs.length > 0 ? { allocations: legs, name: search.get("name") ?? undefined } : undefined;
  }, [search]);
  // A plan handed over in the URL (`&usd=&cadence=`, e.g. from the Copilot) arrives as a full
  // draft, so amount and cadence prefill too — same shape the assistant pane produces.
  const urlDraft = useMemo<AutomationDraft | null>(() => {
    const legs = parseAutomateLegs(search.get("legs"));
    const amountUsd = Number(search.get("usd"));
    const cadenceDays = Number(search.get("cadence"));
    if (legs.length === 0 || !Number.isFinite(amountUsd) || amountUsd < 1 || !Number.isInteger(cadenceDays) || cadenceDays < 1 || cadenceDays > 90) return null;
    const name = search.get("name") ?? undefined;
    const single = legs.length === 1 && legs[0]!.assetAddress !== "USDC" ? legs[0]! : null;
    if (single) return { type: "recurring-buy", assetAddress: single.assetAddress as `0x${string}`, amountUsd, cadenceDays, notes: "" };
    return { type: "recurring-basket", basketName: name, allocations: legs, amountUsd, cadenceDays, notes: "" };
  }, [search]);

  const active = automation.active;
  const perMonth = active.reduce((s, p) => s + ((p.config.amountUsd ?? 0) * 30) / Math.max(1, p.config.cadenceDays ?? 30), 0);
  const invested = automation.plans.reduce((s, p) => s + (p.config.history ?? []).filter((h) => h.ok).reduce((x, h) => x + (h.spentUsd ?? 0), 0), 0);
  const next = active.filter((p) => !p.due && p.nextRunAt).sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];

  const PANES: Array<{ id: Pane; label: string; hint: string }> = [
    { id: "plan", label: "New plan", hint: "stock or basket, amount, cadence, how it runs" },
    { id: "assistant", label: "Draft with the assistant", hint: "a sentence or the guided form fills the plan" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {!embedded && <PageTitle index="08 — Automate" title="Invest on a schedule." lead="A weekly amount into a stock or a basket, bought automatically within limits you set — or with a confirmation per run." />}

      {automation.signedIn && automation.plans.length > 0 && (
        <div className="module-grid grid-cols-2 md:grid-cols-4 ticks">
          <Cell label="Active plans" value={String(active.length)} sub={`${active.filter((p) => p.config.mode === "auto").length} automatic`} />
          <Cell label="Monthly pace" value={formatUsd(perMonth)} sub="across active plans" />
          <Cell label="Invested by plans" value={formatUsd(invested)} sub="recorded runs" />
          <Cell label="Next run" value={automation.due.length > 0 ? "due now" : next ? timeAgo(next.nextRunAt!).replace(/ ago$/, "") : "—"} sub={automation.due.length > 0 ? `${automation.due.length} waiting` : next ? "from now" : "nothing scheduled"} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <Module>
          <div role="tablist" aria-label="Plan builder" className="grid grid-cols-2 p-1 m-3 rounded-[8px] bg-surface-muted">
            {PANES.map((p) => (
              <button key={p.id} role="tab" aria-selected={pane === p.id} onClick={() => setPane(p.id)} className={cx("h-11 rounded-[6px] px-2 text-[13px] font-medium transition-fast flex flex-col items-center justify-center leading-tight", pane === p.id ? "bg-canvas border border-line text-primary" : "text-ink-secondary hover:text-ink")}>
                <span>{p.label}</span>
                <span className="hidden md:block font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">{p.hint}</span>
              </button>
            ))}
          </div>
          <div hidden={pane !== "plan"}>
            <PlanWizard templates={templates ?? []} draft={draft ?? urlDraft} seed={seed} />
          </div>
          <div hidden={pane !== "assistant"} className="p-4 border-t border-line">
            <AiRuleDraft
              onDraft={(d) => {
                setDraft(d);
                setPane("plan");
              }}
            />
          </div>
        </Module>

        <div className="flex flex-col gap-6">
          <PlanList />
          <AutoInvestExplainer />
        </div>
      </div>
    </div>
  );
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="p-4 flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className="display num text-[24px] leading-none">{value}</span>
      {sub && <span className="text-[11px] text-ink-muted">{sub}</span>}
    </div>
  );
}

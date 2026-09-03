"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Bot, Hand, KeyRound } from "lucide-react";
import type { PortfolioTemplate } from "@/lib/client-api";
import type { AutomationDraft } from "@/lib/client-api";
import { useTemplates } from "@/hooks/queries";
import { Module, ModuleHeader, PageTitle, LinkButton, Badge } from "@/components/ui/primitives";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { AutomationModule } from "./AutomationModule";
import { AiRuleDraft } from "./AiRuleDraft";

/**
 * Automate: recurring buys and basket plans, drafted by you or the assistant, executed only when
 * you confirm each run in your wallet (spec §4.8). Unattended execution with Spend Permissions is
 * a later phase and is described honestly here rather than implied.
 */
export function AutomateView({ initialTemplates, embedded = false }: { initialTemplates?: PortfolioTemplate[]; embedded?: boolean }) {
  const { isConnected } = useAccount();
  const { data: templates } = useTemplates(initialTemplates);
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  return (
    <div className="flex flex-col gap-6">
      {!embedded && <PageTitle index="08 — Automate" title="Plans you approve, run by run." lead="Recurring buys and basket plans. Each run waits for your wallet confirmation." action={!isConnected ? <ConnectButton size="lg" /> : <LinkButton href="/portfolio">Portfolio</LinkButton>} />}

      <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start">
        <AutomationModule templates={templates ?? []} draft={draft} />

        <div className="flex flex-col gap-6">
          <Module>
            <ModuleHeader index="AI" title="Draft a plan" action={<Badge>optional</Badge>} />
            <div className="p-4">
              <AiRuleDraft onDraft={setDraft} />
            </div>
          </Module>

          <Module>
            <ModuleHeader title="How the agent works" />
            <ul className="divide-y divide-line">
              {[
                { icon: Hand, title: "Proposes, never moves funds", body: "A due run shows up as a proposal; the trade happens only after you confirm in your wallet." },
                { icon: Bot, title: "Scope-locked assistant", body: "Drafts plans from a sentence using live tickers only. It cannot sign, approve or pick addresses." },
                { icon: KeyRound, title: "Spend Permissions: later", body: "Unattended runs within a limit you set (amount, expiry, listed stocks) are on the roadmap, not live." },
              ].map(({ icon: Icon, title, body }) => (
                <li key={title} className="px-4 py-3 flex gap-3">
                  <Icon size={16} strokeWidth={1.75} className="text-primary shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">{title}</span>
                    <span className="block text-[13px] text-ink-secondary">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="px-4 py-3 border-t border-line text-[12px] text-ink-muted">
              Rebalancing against a template lives under{" "}
              <Link href="/portfolio" className="text-primary font-medium">
                Portfolio → Rebalance
              </Link>
              .
            </p>
          </Module>
        </div>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { Bot, Hand, KeyRound, ShieldCheck, Timer, Wallet } from "lucide-react";
import { useConfigFlags } from "@/hooks/queries";
import { AUTO_INVEST } from "@/lib/auto-invest";
import { BASE_EXPLORER_URL } from "@/config/chain";
import { Module, ModuleHeader, Badge } from "@/components/ui/primitives";

/**
 * What auto-invest promises and who enforces it. Written for the sceptic: every claim names the
 * thing that makes it true (a contract rule, a wallet signature, an allowance), so it can be
 * checked rather than believed.
 */
export function AutoInvestExplainer() {
  const { data: flags } = useConfigFlags();
  const auto = flags?.autoInvest;
  const enabled = !!auto?.enabled;

  const promises = [
    { icon: Timer, title: "Runs by itself, on your schedule", body: "Weekly, daily or monthly: when a run is due, the plan buys your stocks at the best route of the moment. You do not have to be there." },
    { icon: ShieldCheck, title: "Limits the chain enforces", body: `Never more than the amount per run, never more often than the cadence, only through allow-listed routes, and the stock has to land in your wallet — at least the Chainlink reference less your tolerance (${AUTO_INVEST.DEFAULT_SLIPPAGE_BPS / 100}% by default).` },
    { icon: Wallet, title: "Your USDC stays yours until the moment it becomes stock", body: "The plan draws on a normal USDC allowance you set. Nothing is deposited anywhere; a run pulls one run's worth and swaps it in the same transaction." },
    { icon: Hand, title: "Stop any time", body: "Pause, cancel or edit from this page with one signature. Revoking the USDC allowance stops everything, whatever any server thinks." },
  ];

  const roles = [
    { who: "You", does: "Set the stocks, the amount, the cadence and the allowance. Pause, resume, cancel, edit. Can run a due plan yourself." },
    { who: "The contract", does: "Holds the rules and enforces them on every run: amount, cadence, expiry, routes, minimum output. Never holds your stock." },
    { who: "The keeper", does: "A BStocks server account that pays the gas and picks the moment and the route. It cannot change a plan, take more than it allows, or send stock anywhere but to you." },
  ];

  return (
    <Module>
      <ModuleHeader
        title="How auto-invest works"
        action={enabled ? <Badge tone="positive">live on Base</Badge> : <Badge>not enabled here</Badge>}
      />
      <ul className="divide-y divide-line">
        {promises.map(({ icon: Icon, title, body }) => (
          <li key={title} className="px-4 py-3 flex gap-3">
            <Icon size={16} strokeWidth={1.75} className="text-primary shrink-0 mt-0.5" />
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">{title}</span>
              <span className="block text-[13px] text-ink-secondary">{body}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="border-t border-line">
        <div className="px-4 pt-3 pb-1 eyebrow">Who does what</div>
        <dl className="px-4 pb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
          {roles.map((r) => (
            <div key={r.who} className="contents">
              <dt className="font-medium">{r.who}</dt>
              <dd className="text-ink-secondary">{r.does}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ul className="border-t border-line divide-y divide-line">
        <li className="px-4 py-3 flex gap-3">
          <Bot size={16} strokeWidth={1.75} className="text-primary shrink-0 mt-0.5" />
          <span className="min-w-0 text-[13px] text-ink-secondary">
            <span className="block text-[14px] font-medium text-ink">Confirm-each-run plans still exist</span>
            Prefer to sign every purchase? A manual plan proposes a run when it is due and waits for your wallet. Nothing runs unattended.
          </span>
        </li>
        <li className="px-4 py-3 flex gap-3">
          <KeyRound size={16} strokeWidth={1.75} className="text-primary shrink-0 mt-0.5" />
          <span className="min-w-0 text-[13px] text-ink-secondary">
            <span className="block text-[14px] font-medium text-ink">Open source, verifiable</span>
            {enabled && auto?.address ? (
              <>
                The contract is{" "}
                <a href={`${BASE_EXPLORER_URL}/address/${auto.address}`} target="_blank" rel="noopener noreferrer" className="text-primary font-mono">
                  {auto.address.slice(0, 6)}…{auto.address.slice(-4)}
                </a>{" "}
                on Base. New routes are announced onchain 24 hours before they can be used.
                {!auto.keeperConfigured && " No keeper is configured on this deployment yet, so due runs wait for you to press Run."}
              </>
            ) : (
              "The contract source lives in the repository; this deployment has not enabled it yet, so plans here are confirmed by you run by run."
            )}
          </span>
        </li>
      </ul>
      <p className="px-4 py-3 border-t border-line text-[12px] text-ink-muted">
        Rebalancing against a target lives under{" "}
        <Link href="/portfolio?tab=rebalance" className="text-primary font-medium">
          Portfolio → Rebalance
        </Link>
        . Plans buy; they never sell.
      </p>
    </Module>
  );
}

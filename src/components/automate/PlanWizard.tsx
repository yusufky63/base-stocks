"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { Repeat, Sparkles, Zap } from "lucide-react";
import type { Address } from "viem";
import type { Allocation, PortfolioTemplate } from "@/domain/portfolio";
import { TOTAL_BPS, USDC_ALLOCATION_KEY } from "@/domain/portfolio";
import { apiPost, ApiError, type AutomationDraft } from "@/lib/client-api";
import { useAssets, useConfigFlags } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { useAutomation } from "@/hooks/useAutomation";
import { useAutoInvest } from "@/hooks/useAutoInvest";
import { useNow } from "@/hooks/useNow";
import { AUTO_INVEST, CADENCES, cadenceNoun, decodeAutoInvestError } from "@/lib/auto-invest";
import { legBlockedReason, premiumBeyondFloor, referenceGap, referenceGapNote } from "@/lib/trading-status";
import { validateAllocations } from "@/services/portfolio-service";
import { formatUsd, bpsToPct } from "@/lib/format";
import { MIN_TRADE_USD, BASE_EXPLORER_URL } from "@/config/chain";
import { humanizeError } from "@/lib/errors";
import { AssetLogo, ErrorBanner, InfoBanner } from "@/components/common/display";
import { ColorDot } from "@/components/common/AllocationBar";
import { AllocationEditor } from "@/components/build/AllocationEditor";
import { StockPicker } from "@/components/build/StockPicker";
import { Button, Badge, cx } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { ConnectButton } from "@/components/layout/ConnectButton";
import { SignInButton } from "@/components/layout/SignInButton";

const AMOUNTS = [10, 25, 50, 100, 250] as const;
const MAX_AMOUNT = 1000;
const DURATIONS = [
  { days: 90, label: "3 months" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
  { days: 0, label: "No end" },
] as const;
const SLIPPAGES = [
  { bps: 100, label: "1%" },
  { bps: 300, label: "3%" },
  { bps: 500, label: "5%" },
] as const;

export interface WizardSeed {
  allocations: Allocation[];
  name?: string;
}

type Kind = "stock" | "basket";
type BasketSource = "template" | "own";
type Mode = "auto" | "manual";
type AmountChoice = (typeof AMOUNTS)[number] | "custom";

/**
 * New plan, top to bottom: what to buy, how much and how often, how it runs, then one button. A
 * basket can be a template, a mix you pick yourself (equal weights to start, then sliders and a
 * cash share), or one handed over from Build, a community page or the assistant. Every prefill is
 * only that: nothing is saved or signed until the button.
 */
export function PlanWizard({ templates, draft, seed }: { templates: PortfolioTemplate[]; draft: AutomationDraft | null; seed?: WizardSeed }) {
  const { isConnected } = useAccount();
  const { data: assets } = useAssets();
  const { data: flags } = useConfigFlags();
  const auth = useAuth();
  const automation = useAutomation();
  const autoInvest = useAutoInvest();
  const now = useNow(60_000);
  const autoAvailable = !!flags?.autoInvest?.enabled;

  const seededBasket = !!seed && seed.allocations.length > 1;
  const [kind, setKind] = useState<Kind>(seededBasket ? "basket" : "stock");
  const [asset, setAsset] = useState<string>(seed && seed.allocations.length === 1 && seed.allocations[0]!.assetAddress !== USDC_ALLOCATION_KEY ? (seed.allocations[0]!.assetAddress as string) : "");
  const [basketSource, setBasketSource] = useState<BasketSource>(seededBasket ? "own" : "template");
  const [templateId, setTemplateId] = useState<string>("");
  const [own, setOwn] = useState<Allocation[]>(seededBasket ? seed!.allocations : []);
  const [ownName, setOwnName] = useState<string>(seededBasket ? (seed!.name ?? "") : "");
  const [amount, setAmount] = useState(25);
  const [amountChoice, setAmountChoice] = useState<AmountChoice>(25);
  const [cadence, setCadence] = useState(7);
  const [mode, setMode] = useState<Mode>(autoAvailable ? "auto" : "manual");
  const [modeTouched, setModeTouched] = useState(false);
  const [duration, setDuration] = useState<number>(180);
  const [slippage, setSlippage] = useState<number>(AUTO_INVEST.DEFAULT_SLIPPAGE_BPS);
  const [approveOverride, setApproveOverride] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ mode: Mode; txHash?: string } | null>(null);

  const chooseAmount = (usd: number) => {
    setAmount(usd);
    setAmountChoice((AMOUNTS as readonly number[]).includes(usd) ? (usd as AmountChoice) : "custom");
  };

  // Auto becomes the default the moment the flags say it exists, unless the user already chose.
  const [seenAuto, setSeenAuto] = useState(autoAvailable);
  if (autoAvailable !== seenAuto) {
    setSeenAuto(autoAvailable);
    if (!modeTouched) setMode(autoAvailable ? "auto" : "manual");
  }

  // A new AI draft prefills the form (render-time adjust; nothing is saved until the button).
  const [seenDraft, setSeenDraft] = useState<AutomationDraft | null>(null);
  if (draft !== seenDraft) {
    setSeenDraft(draft);
    if (draft) {
      chooseAmount(Math.min(MAX_AMOUNT, Math.max(MIN_TRADE_USD, Math.round(draft.amountUsd * 100) / 100)));
      setCadence(draft.cadenceDays);
      if (draft.type === "recurring-buy") {
        setKind("stock");
        setAsset(draft.assetAddress ?? "");
      } else {
        setKind("basket");
        setBasketSource("own");
        setOwn(draft.allocations ?? []);
        setOwnName(draft.basketName ?? "");
      }
      setDone(null);
    }
  }

  const live = (assets?.assets ?? []).filter((a) => a.status === "active" && BigInt(a.totalSupply ?? "0") > 0n);
  const assetOptions = live.map((a) => ({ value: a.address as string, label: `${a.underlying} — ${a.name}` }));
  const templateOptions = templates.map((t) => ({ value: t.id, label: t.name }));
  const template = templates.find((t) => t.id === templateId);
  const infoOf = (address: string) => assets?.assets.find((x) => x.canonicalId === address.toLowerCase());
  const ownStocks = own.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
  const ownTickers = ownStocks.map((a) => infoOf(a.assetAddress as string)?.underlying ?? (a.assetAddress as string).slice(0, 6));

  const allocations: Allocation[] = kind === "stock" ? (asset ? [{ assetAddress: asset as Address, weightBps: TOTAL_BPS }] : []) : basketSource === "template" ? (template?.allocations ?? []) : own;
  const name = kind === "stock" ? (live.find((a) => a.canonicalId === asset.toLowerCase())?.underlying ?? "stock") : basketSource === "template" ? (template?.name ?? "basket") : (ownName.trim() || ownTickers.join(" + ") || "My mix");
  const ownValid = kind !== "basket" || basketSource !== "own" || validateAllocations(own).ok;
  const stockLegs = allocations.filter((a) => a.assetAddress !== USDC_ALLOCATION_KEY);
  const cashBps = allocations.filter((a) => a.assetAddress === USDC_ALLOCATION_KEY).reduce((s, a) => s + a.weightBps, 0);
  const legs = stockLegs.map((a) => {
    const info = infoOf(a.assetAddress as string);
    const usd = (amount * a.weightBps) / TOTAL_BPS;
    // A leg under the per-trade minimum is skipped every run, so it is flagged here, before the plan exists.
    const price = info ? assets?.prices[info.canonicalId] : undefined;
    const blocked = usd < MIN_TRADE_USD ? `under the $${MIN_TRADE_USD} per-leg minimum at this amount` : info ? legBlockedReason("buy", info, price, usd) : "not in the verified registry";
    // An automatic run fills no worse than the Chainlink reference minus the slippage limit, so a
    // pool trading above that is a leg the contract will skip — said here, not found in history.
    const gap = referenceGapNote(price);
    const gapPct = referenceGap(price)?.pct ?? null;
    const beyondFloor = mode === "auto" && premiumBeyondFloor(price, slippage);
    return { key: a.assetAddress as string, weightBps: a.weightBps, usd, info, blocked, gap, gapPct, beyondFloor };
  });
  const premiumLegs = legs.filter((l) => !l.blocked && l.beyondFloor);
  const smallestBps = stockLegs.reduce((m, a) => Math.min(m, a.weightBps), TOTAL_BPS);
  /** The amount per run at which every stock leg clears the minimum. */
  const amountForAllLegs = stockLegs.length > 0 ? Math.ceil((MIN_TRADE_USD * TOTAL_BPS) / smallestBps) : MIN_TRADE_USD;
  const tooSmall = legs.filter((l) => l.usd < MIN_TRADE_USD);
  const ready = ownValid && legs.length > 0 && legs.length <= AUTO_INVEST.MAX_LEGS && amount >= MIN_TRADE_USD && tooSmall.length < legs.length;
  const runsInDuration = duration > 0 ? Math.max(1, Math.ceil(duration / cadence)) : Math.max(1, Math.ceil(180 / cadence));
  const suggestedApprove = Math.min(1_000_000, Math.ceil(amount * runsInDuration));
  const approveUsd = approveOverride ?? suggestedApprove;

  const submit = async () => {
    setError(null);
    setSaving(true);
    try {
      if (mode === "auto") {
        if (!now) throw new ApiError("BAD_REQUEST", "One moment — the page is still loading.", 400);
        const expiryAt = duration > 0 ? now + duration * 86_400_000 : null;
        const res = await autoInvest.createPlan({ allocations, amountUsd: amount, cadenceDays: cadence, expiryAt, maxSlippageBps: slippage, approveUsd, basketName: kind === "basket" ? name : undefined });
        setDone({ mode: "auto", txHash: res.txHash });
      } else {
        await auth.ensureSignedIn();
        await apiPost("/api/automation", kind === "stock" ? { type: "recurring-buy", mode: "manual", assetAddress: asset, amountUsd: amount, cadenceDays: cadence } : { type: "recurring-basket", mode: "manual", allocations, basketName: name, amountUsd: amount, cadenceDays: cadence });
        await automation.invalidate();
        setDone({ mode: "manual" });
      }
    } catch (err) {
      const decoded = decodeAutoInvestError(err);
      setError(decoded?.message ?? (err instanceof ApiError ? err.message : humanizeError(err).message));
    } finally {
      setSaving(false);
    }
  };

  const step = "font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted";

  return (
    <div className="p-4 flex flex-col gap-6 border-t border-line">
      {/* 1. What */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <span className={step}>1 · What to buy</span>
          {autoAvailable ? <Badge tone="primary">automatic available</Badge> : <Badge>you confirm every run</Badge>}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3 items-start">
          <Segmented size="sm" ariaLabel="Kind of plan" value={kind} onChange={setKind} options={[{ value: "stock", label: "One stock" }, { value: "basket", label: "A basket" }]} />
          {kind === "stock" ? (
            <Select value={asset} onChange={setAsset} options={assetOptions} ariaLabel="Stock" placeholder={live.length ? "Pick a live stock…" : "No live stocks right now"} disabled={live.length === 0} />
          ) : (
            <Segmented size="sm" ariaLabel="Basket source" value={basketSource} onChange={setBasketSource} options={[{ value: "template", label: "Template" }, { value: "own", label: "Your own mix" }]} className="md:max-w-[320px]" />
          )}
        </div>

        {kind === "basket" && basketSource === "template" && <Select value={templateId} onChange={setTemplateId} options={templateOptions} ariaLabel="Template" placeholder="Pick a template…" />}

        {kind === "basket" && basketSource === "own" && (
          <div className="flex flex-col gap-3 border border-line rounded-[8px] p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <span className="text-[12px] text-ink-secondary">Tap the stocks you want. They start at equal weights; adjust below.</span>
              {ownStocks.length > 0 && (
                <button type="button" className="text-[12px] text-ink-secondary hover:text-ink" onClick={() => setOwn([])}>
                  Clear
                </button>
              )}
            </div>
            {assets && <StockPicker assets={assets.assets} prices={assets.prices} value={own} onChange={setOwn} columns="grid-cols-3 sm:grid-cols-4" />}
            {own.length > 0 && assets && (
              <>
                <AllocationEditor assets={assets.assets} value={own} onChange={setOwn} />
                <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
                  <span className="shrink-0">Basket name</span>
                  <input value={ownName} onChange={(e) => setOwnName(e.target.value.slice(0, 48))} placeholder={ownTickers.join(" + ") || "My mix"} className="flex-1 h-9 rounded-[6px] border border-line-strong focus:border-primary bg-canvas px-2 text-[13px] placeholder:text-ink-muted" aria-label="Basket name" />
                </label>
              </>
            )}
          </div>
        )}

        {legs.length > 0 && (kind === "stock" || basketSource === "template") && (
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 border border-line rounded-[6px] px-3 py-2">
            {legs.map((l) => (
              <li key={l.key} className={cx("flex items-center gap-2 text-[13px] min-w-0", l.blocked && "text-ink-muted")}>
                <ColorDot k={l.key} />
                {l.info && <AssetLogo src={l.info.logoURI} symbol={l.info.symbol} size={20} />}
                <span className="font-medium">{l.info?.underlying ?? l.key.slice(0, 6)}</span>
                <span className="font-mono num text-[12px] text-ink-secondary">{bpsToPct(l.weightBps)} · {formatUsd(l.usd)}</span>
                {l.blocked ? (
                  <span className="ml-auto text-[11px] text-warning-fg truncate">{l.blocked}</span>
                ) : l.gap ? (
                  <span className={cx("ml-auto text-[11px] truncate", l.beyondFloor ? "text-warning-fg" : "text-ink-muted")} title={l.gap}>
                    {(l.gapPct ?? 0) > 0 ? "+" : ""}
                    {(l.gapPct ?? 0).toFixed(0)}% vs stock price{l.beyondFloor ? " · skipped" : ""}
                  </span>
                ) : null}
              </li>
            ))}
            {cashBps > 0 && <li className="text-[12px] text-ink-muted md:col-span-2">{bpsToPct(cashBps)} cash share stays in your wallet each run.</li>}
          </ul>
        )}
        {kind === "basket" && basketSource === "own" && legs.some((l) => l.blocked || l.gap) && (
          <ul className="text-[12px] flex flex-col gap-0.5">
            {legs
              .filter((l) => l.blocked || l.gap)
              .map((l) => (
                <li key={l.key} className={l.blocked || l.beyondFloor ? "text-warning-fg" : "text-ink-muted"}>
                  {l.info?.underlying ?? l.key.slice(0, 6)} · {formatUsd(l.usd)} per run: {l.blocked ?? l.gap}
                </li>
              ))}
          </ul>
        )}
        {premiumLegs.length > 0 && (
          <InfoBanner tone="warning">
            {premiumLegs.map((l) => `${l.info?.underlying ?? l.key.slice(0, 6)} (+${(l.gapPct ?? 0).toFixed(0)}%)`).join(", ")} {premiumLegs.length === 1 ? "trades" : "trade"} above the stock&apos;s own price by more than the {slippage / 100}% limit in step 3. An automatic run fills no worse than the stock price minus that limit, so {premiumLegs.length === 1 ? "this leg is" : "these legs are"} skipped until the gap narrows; the share stays in your wallet each time.
          </InfoBanner>
        )}
      </section>

      {/* 2. How much, how often */}
      <section className="flex flex-col gap-3">
        <span className={step}>2 · How much, how often</span>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
          <Segmented size="sm" ariaLabel="Amount per run" value={amountChoice} onChange={(v) => (v === "custom" ? setAmountChoice("custom") : chooseAmount(v))} options={[...AMOUNTS.map((v) => ({ value: v as AmountChoice, label: `$${v}` })), { value: "custom" as AmountChoice, label: "Custom" }]} />
          <label className={cx("flex items-center h-9 rounded-[6px] border px-2 gap-1 text-[13px] transition-fast focus-within:border-primary", amountChoice === "custom" ? "border-primary" : "border-line-strong")}>
            <span className="text-ink-secondary">$</span>
            <input type="number" inputMode="decimal" min={MIN_TRADE_USD} max={MAX_AMOUNT} step="any" value={amount} onFocus={() => setAmountChoice("custom")} onChange={(e) => chooseAmount(Math.min(MAX_AMOUNT, Math.max(MIN_TRADE_USD, Number(e.target.value) || MIN_TRADE_USD)))} aria-label="Custom amount per run" className="w-20 bg-transparent outline-none num text-right" />
            <span className="text-[11px] text-ink-muted">per run</span>
          </label>
        </div>
        <Segmented size="sm" ariaLabel="Cadence" value={cadence} onChange={setCadence} options={CADENCES.map((c) => ({ value: c.days, label: c.label }))} />
        <p className="text-[12px] text-ink-secondary">
          {formatUsd(amount)} every {cadenceNoun(cadence)} · about {formatUsd((amount * 30) / cadence)} a month.
        </p>
        {tooSmall.length > 0 && (
          <InfoBanner tone="warning">
            At {formatUsd(amount)} per run, {tooSmall.map((l) => `${l.info?.underlying ?? l.key.slice(0, 6)} (${formatUsd(l.usd)})`).join(", ")} {tooSmall.length === 1 ? "falls" : "fall"} under the {formatUsd(MIN_TRADE_USD)} per-leg minimum and would be skipped every run — that share just stays in your wallet.{" "}
            <button type="button" className="font-medium text-primary" onClick={() => chooseAmount(Math.min(MAX_AMOUNT, amountForAllLegs))}>
              Raise to {formatUsd(Math.min(MAX_AMOUNT, amountForAllLegs))}
            </button>{" "}
            to buy every stock each run.
          </InfoBanner>
        )}
      </section>

      {/* 3. How it runs */}
      <section className="flex flex-col gap-3">
        <span className={step}>3 · How it runs</span>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <ModeCard
            active={mode === "auto"}
            disabled={!autoAvailable}
            icon={Zap}
            title="Automatic"
            body={autoAvailable ? "Runs by itself when due, within limits the contract enforces. One signature to start." : "Not enabled on this deployment yet."}
            onClick={() => {
              setMode("auto");
              setModeTouched(true);
            }}
          />
          <ModeCard
            active={mode === "manual"}
            icon={Repeat}
            title="You confirm each run"
            body="A due run shows up here and waits for your wallet. Nothing runs unattended."
            onClick={() => {
              setMode("manual");
              setModeTouched(true);
            }}
          />
        </div>
        {mode === "auto" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 border border-line rounded-[6px] p-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Run for</span>
              <Segmented size="sm" ariaLabel="Duration" value={duration} onChange={setDuration} options={DURATIONS.map((d) => ({ value: d.days, label: d.label }))} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Fill no worse than the stock&apos;s own price minus</span>
              <Segmented size="sm" ariaLabel="Slippage tolerance" value={slippage} onChange={setSlippage} options={SLIPPAGES.map((s) => ({ value: s.bps, label: s.label }))} />
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[12px] text-ink-secondary">USDC the plan may draw in total (allowance)</span>
                <label className="flex items-center h-9 rounded-[6px] border border-line-strong focus-within:border-primary px-2 gap-1 text-[13px]">
                  <span className="text-ink-secondary">$</span>
                  <input type="number" inputMode="decimal" min={amount} step="any" value={approveUsd} onChange={(e) => setApproveOverride(Math.max(amount, Number(e.target.value) || amount))} aria-label="USDC allowance" className="w-24 bg-transparent outline-none num text-right" />
                </label>
              </div>
              <p className="text-[11px] text-ink-muted">
                {approveUsd >= amount * runsInDuration ? `Covers ${Math.floor(approveUsd / amount)} runs` : `Covers ${Math.floor(approveUsd / amount)} of the ${runsInDuration} runs planned`} · a standard USDC allowance you can raise or revoke at any time from Manage. The contract can never take more than {formatUsd(amount)} per run regardless.
              </p>
            </div>
          </div>
        )}
      </section>

      {/* 4. Go */}
      {error && <ErrorBanner message={error} />}
      {done ? (
        <InfoBanner tone="positive">
          {done.mode === "auto" ? (
            <>
              Plan started onchain. The first run is due now and will be picked up by the keeper{flags?.autoInvest?.keeperConfigured ? "" : " — none is configured here, so press Run now under Manage"}.{" "}
              {done.txHash && (
                <a href={`${BASE_EXPLORER_URL}/tx/${done.txHash}`} target="_blank" rel="noopener noreferrer" className="text-primary font-medium">
                  View transaction
                </a>
              )}
            </>
          ) : (
            "Plan saved. It is due now: confirm the first run from Manage whenever you like."
          )}
        </InfoBanner>
      ) : !isConnected ? (
        <ConnectButton full />
      ) : mode === "manual" && !auth.isSignedIn ? (
        <SignInButton size="md" full label="Sign in to save the plan" />
      ) : (
        <Button size="lg" full loading={saving || autoInvest.busy} disabled={!ready} onClick={() => void submit()}>
          {mode === "auto" ? <Zap size={16} strokeWidth={1.75} /> : <Repeat size={16} strokeWidth={1.75} />}
          {mode === "auto" ? `Start auto-invest · ${formatUsd(amount)} every ${cadenceNoun(cadence)}` : `Save plan · ${formatUsd(amount)} every ${cadenceNoun(cadence)}`}
        </Button>
      )}
      {autoInvest.busy && <p className="text-[12px] text-ink-secondary">{autoInvest.phase === "wallet" ? "Confirm in your wallet…" : autoInvest.phase === "submitted" ? "Waiting for Base…" : autoInvest.phase === "recording" ? "Saving the plan…" : "Preparing…"}</p>}
      <p className="text-[12px] text-ink-muted inline-flex items-start gap-1.5">
        <Sparkles size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />
        <span>Legs that cannot be bought on a given day (not issued, no pool, paused, too thin, or under the {formatUsd(MIN_TRADE_USD)} minimum) are skipped that day and their share stays in your wallet. A template is not a recommendation.</span>
      </p>
    </div>
  );
}

function ModeCard({ active, disabled, icon: Icon, title, body, onClick }: { active: boolean; disabled?: boolean; icon: typeof Zap; title: string; body: string; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-pressed={active} className={cx("text-left rounded-[6px] border p-3 flex gap-3 transition-fast disabled:opacity-50 disabled:cursor-not-allowed", active ? "border-primary bg-primary-soft" : "border-line hover:border-line-strong")}>
      <Icon size={16} strokeWidth={1.75} className={cx("shrink-0 mt-0.5", active ? "text-primary" : "text-ink-secondary")} />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12px] text-ink-secondary">{body}</span>
      </span>
    </button>
  );
}

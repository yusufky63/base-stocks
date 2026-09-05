"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Repeat, Upload } from "lucide-react";
import type { Allocation, PortfolioTemplate } from "@/domain/portfolio";
import type { CommunityBasket } from "@/domain/community";
import { apiGet, apiPost, ApiError, type AssetsResponse, type DraftCommentary as Commentary } from "@/lib/client-api";
import { useAssets, useConfigFlags, useTemplates } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { Module, ModuleHeader, Skeleton, Button, cx } from "@/components/ui/primitives";

import { Collapsible } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { AllocationEditor } from "./AllocationEditor";
import { PlanExecutor } from "./PlanExecutor";
import { AiIntentInput } from "./AiIntentInput";
import { DraftCommentary } from "./DraftCommentary";
import { RecentBaskets } from "./RecentBaskets";
import { StockPicker } from "./StockPicker";
import { useRecentBaskets } from "@/hooks/useRecentBaskets";
import type { SavedBasketSource } from "@/lib/recent-baskets";
import { TemplateCard } from "./TemplateCard";
import { partitionTemplates } from "@/lib/templates";
import { validateAllocations } from "@/services/portfolio-service";
import { automateHref } from "@/lib/automate-link";
import { SignInButton } from "@/components/layout/SignInButton";
import { Dither } from "@/components/fx/lazy";

type StartMode = "ai" | "template" | "own" | "recent";

/**
 * Build in three moves: pick a starting point (an AI draft, a template, or stocks you tap
 * yourself), adjust the basket in the editor, invest with live quotes. Publishing is tucked under
 * the editor; a basket can also be handed to Automate to repeat on a schedule.
 */
export function BuildView({ initialAssets, initialTemplates, embedded = false }: { initialAssets?: AssetsResponse; initialTemplates?: PortfolioTemplate[]; embedded?: boolean }) {
  const { data: assets } = useAssets(initialAssets);
  const { data: templates } = useTemplates(initialTemplates);
  const { data: flags } = useConfigFlags();
  const search = useSearchParams();
  const auth = useAuth();
  const cloneId = search.get("basket");
  const wantsPublish = search.get("publish") === "1";
  const cloned = useQuery({ queryKey: ["basket", cloneId], queryFn: () => apiGet<{ basket: CommunityBasket }>(`/api/baskets/${cloneId}`), enabled: !!cloneId });
  const [mode, setMode] = useState<StartMode>("ai");
  /** AI is the default start; when the operator disabled it the templates take its place. */
  const activeMode: StartMode = mode === "ai" && flags?.aiEnabled === false ? "template" : mode;
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [name, setName] = useState<string>("Custom portfolio");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<"template" | "custom" | "ai">("custom");
  const [loadedClone, setLoadedClone] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  /** The assistant's reasoning for its last draft; stays visible after edits, marked as belonging to the draft. */
  const [commentary, setCommentary] = useState<Commentary | null>(null);
  const valid = validateAllocations(allocations).ok;
  const baskets = useRecentBaskets();
  const { saveDraft } = baskets;

  // The basket left in the editor last time comes back on its own — once, and only into an empty
  // editor that was not opened to clone something (adjust-on-prop-change pattern, no effect).
  const [restored, setRestored] = useState(false);
  if (!restored && baskets.draft && allocations.length === 0 && !cloneId) {
    setRestored(true);
    setAllocations(baskets.draft.allocations);
    setName(baskets.draft.name);
    setSource(baskets.draft.source);
  }
  // …and what is in the editor is kept on this device as it changes.
  useEffect(() => {
    if (allocations.length === 0) return;
    saveDraft({ id: "draft", name, allocations, source, savedAt: Date.now() });
  }, [allocations, name, source, saveDraft]);

  const clearEditor = () => {
    setAllocations([]);
    setName("Custom portfolio");
    setSource("custom");
    setCommentary(null);
    baskets.saveDraft(null);
  };

  // Clone a community basket into the editor once (URL param → state, adjust-on-prop-change pattern).
  const clonedBasket = cloned.data?.basket;
  if (clonedBasket && loadedClone !== clonedBasket.id) {
    setLoadedClone(clonedBasket.id);
    setAllocations(clonedBasket.allocations);
    setName(`${clonedBasket.name} (clone)`);
  }

  const publish = useMutation({
    mutationFn: async () => {
      await auth.ensureSignedIn();
      return apiPost<{ basket: CommunityBasket }>("/api/baskets", { name, description, allocations });
    },
    onSuccess: () => baskets.rememberBasket({ name, allocations, source }),
  });

  const load = (next: Allocation[], label: string, from: SavedBasketSource, why?: Commentary) => {
    if (executing) return;
    setAllocations(next);
    setName(label);
    setSource(from);
    setCommentary(from === "ai" ? (why ?? null) : null);
    baskets.rememberBasket({ name: label, allocations: next, source: from });
    if (typeof document !== "undefined") document.getElementById("basket-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const MODES: Array<{ id: StartMode; label: string; hint: string }> = [
    { id: "ai", label: "AI draft", hint: "a theme, a risk profile, a reason" },
    { id: "template", label: "Templates", hint: "ready-made mixes, live stocks first" },
    { id: "own", label: "Your own", hint: "tap the stocks, tune the weights below" },
    { id: "recent", label: "Recent", hint: "kept on this device" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {!embedded && (
        <section className="hero-fx border border-line rounded-[8px] ticks bg-canvas overflow-hidden">
          <Dither className="fx-layer" pixelSize={6} opacity={0.28} speed={0.3} />
          <div className="fx-content p-6 md:p-10 grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-end">
            <div className="reveal">
              <div className="eyebrow mb-3">03 — Build</div>
              <h1 className="display text-[40px] md:text-[64px] leading-[0.92] uppercase">
                Build
                <br />a portfolio
                <br />
                <span className="text-primary">your way.</span>
              </h1>
            </div>
            <p className="max-w-[44ch] text-ink-secondary text-[15px] bg-canvas/80 rounded-[6px] p-2 -m-2">Pick a start, adjust the mix, invest. Each purchase is a trade you confirm.</p>
          </div>
        </section>
      )}

      <Module>
        <div role="tablist" aria-label="Starting point" className={cx("grid p-1 m-3 rounded-[8px] bg-surface-muted", flags?.aiEnabled === false ? "grid-cols-3" : "grid-cols-4")}>
          {MODES.filter((m) => m.id !== "ai" || flags?.aiEnabled !== false).map((m) => (
            <button key={m.id} role="tab" aria-selected={activeMode === m.id} onClick={() => setMode(m.id)} className={cx("h-11 rounded-[6px] px-2 text-[13px] font-medium transition-fast flex flex-col items-center justify-center leading-tight", activeMode === m.id ? "bg-canvas border border-line text-primary" : "text-ink-secondary hover:text-ink")}>
              <span>{m.label}</span>
              <span className="hidden md:block font-mono text-[10px] uppercase tracking-[0.06em] text-ink-muted">{m.hint}</span>
            </button>
          ))}
        </div>
        <div className="px-4 pb-4 pt-1 border-t border-line">
          {activeMode === "template" && (
            <div className="pt-3">
              <TemplateShelf templates={templates} assets={assets} onLoad={(tpl) => load(tpl.allocations, tpl.name, "template")} />
            </div>
          )}
          {activeMode === "ai" && (
            <div className="pt-3">
              <AiIntentInput onIntent={(intent) => load(intent.allocations, intent.name || "AI draft", "ai", intent.commentary)} />
            </div>
          )}
          {activeMode === "own" && (
            <div className="pt-3 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-[13px] text-ink-secondary">Tap the stocks you want. They start at equal weights; tune the sliders and add a cash share below.</p>
                {allocations.length > 0 && (
                  <button type="button" className="text-[12px] text-ink-secondary hover:text-ink" disabled={executing} onClick={clearEditor}>
                    Clear
                  </button>
                )}
              </div>
              {assets ? (
                <StockPicker
                  assets={assets.assets}
                  prices={assets.prices}
                  value={allocations}
                  disabled={executing}
                  onChange={(next) => {
                    setAllocations(next);
                    setSource("custom");
                    setCommentary(null);
                    if (name === "Custom portfolio" || name === "AI draft") setName("My basket");
                  }}
                />
              ) : (
                <Skeleton className="h-24" />
              )}
            </div>
          )}
          {activeMode === "recent" && (
            <div className="pt-3">
              <RecentBaskets items={baskets.recent} assets={assets} disabled={executing} onLoad={(b) => load(b.allocations, b.name, b.source)} onForget={baskets.forget} />
            </div>
          )}
        </div>
      </Module>

      <div id="basket-editor" className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start scroll-mt-24">
        <div className="flex flex-col gap-6 min-w-0">
        <Module ticks>
          <ModuleHeader
            index="B"
            title={name}
            action={<span className="font-mono text-[11px] text-ink-muted">{executing ? "locked while buying" : `${allocations.length} ${allocations.length === 1 ? "leg" : "legs"}${cloneId ? " · cloned" : ""}`}</span>}
          />
          <div className="p-4 flex flex-col gap-4">
            {restored && allocations.length > 0 && (
              <p className="text-[12px] text-ink-muted flex items-center gap-2 flex-wrap">
                Restored the basket you left here last time.
                <button type="button" className="text-primary font-medium" disabled={executing} onClick={clearEditor}>
                  Start fresh
                </button>
              </p>
            )}
            {assets ? (
              <AllocationEditor
                assets={assets.assets}
                value={allocations}
                disabled={executing}
                onChange={(next) => {
                  setAllocations(next);
                  setSource("custom");
                }}
              />
            ) : (
              <Skeleton className="h-32" />
            )}
            {valid && (
              <div className="flex items-center gap-2 flex-wrap text-[13px]">
                <Link href={automateHref(allocations, name)} onClick={() => baskets.rememberBasket({ name, allocations, source })} className="inline-flex items-center gap-1.5 text-primary font-medium">
                  <Repeat size={14} strokeWidth={1.75} /> Repeat this basket on a schedule
                </Link>
                <span className="text-ink-muted">Weekly, monthly, automatic or confirmed by you — set it up under Automate.</span>
              </div>
            )}
            <Collapsible title="Publish this basket to the community" defaultOpen={wantsPublish}>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <Input label="Basket name" value={name} onChange={(e) => setName(e.target.value)} maxLength={48} />
                  <Input label="One-line description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} placeholder="Why this mix?" />
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {auth.isSignedIn ? (
                    <Button size="sm" variant="secondary" loading={publish.isPending} disabled={!valid || name.trim().length < 3} onClick={() => publish.mutate()}>
                      <Upload size={14} strokeWidth={1.75} /> Publish
                    </Button>
                  ) : (
                    <SignInButton label="Sign in to publish" />
                  )}
                  {publish.data && (
                    <Link href={`/baskets/${publish.data.basket.id}`} className="text-[13px] text-primary font-medium">
                      Published → view basket
                    </Link>
                  )}
                  {publish.error && <span className="text-[13px] text-danger-fg">{publish.error instanceof ApiError ? publish.error.message : "Could not publish."}</span>}
                  <span className="text-[12px] text-ink-muted">Public, votable, clonable. A template, not a recommendation.</span>
                </div>
              </div>
            </Collapsible>
          </div>
        </Module>
        {commentary && <DraftCommentary commentary={commentary} stale={source !== "ai"} />}
        </div>
        <Module className="lg:sticky lg:top-[72px]">
          <ModuleHeader index="C" title="Invest" />
          <div className="p-4">
            <PlanExecutor allocations={allocations} source={source} disabled={!valid} onExecutingChange={setExecuting} onStart={() => baskets.rememberBasket({ name, allocations, source })} />
          </div>
        </Module>
      </div>

      <p className="text-[12px] text-ink-muted">
        Templates and drafts are starting points, not investment recommendations. Stocks that cannot be bought today stay as USDC in the plan.{" "}
        <Link href="/community" className="text-primary font-medium">
          Community baskets →
        </Link>
      </p>
    </div>
  );
}

/**
 * Templates on two shelves. The default one holds what your money can actually go into today; the
 * second holds the ones stalled on an issuer, collapsed but counted, because hiding them silently
 * would be its own kind of lie. A stalled template returns to the first shelf on its own the day
 * Coinbase mints what it was waiting for — nothing here is a hand-edited list.
 */
function TemplateShelf({ templates, assets, onLoad }: { templates?: PortfolioTemplate[]; assets?: AssetsResponse; onLoad: (t: PortfolioTemplate) => void }) {
  const [showStalled, setShowStalled] = useState(false);
  if (!templates) return <Skeleton className="h-36" />;
  if (templates.length === 0) return <p className="text-[13px] text-ink-secondary">No templates yet.</p>;
  const { ready, stalled } = partitionTemplates(templates, assets);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {ready.map((t) => (
          <TemplateCard key={t.id} template={t} assets={assets} compact onLoad={onLoad} />
        ))}
      </div>
      {ready.length === 0 && <p className="text-[13px] text-ink-secondary">Every template is waiting on a stock that is not issued on Base yet. Build one from scratch below, or open the list.</p>}
      {stalled.length > 0 && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowStalled((v) => !v)}
            className="self-start text-[12px] text-ink-secondary hover:text-ink transition-fast"
          >
            {showStalled ? "Hide" : "Show"} {stalled.length} template{stalled.length === 1 ? "" : "s"} waiting on a stock Coinbase has not issued yet
          </button>
          {showStalled && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {stalled.map((t) => (
                <TemplateCard key={t.id} template={t} assets={assets} compact onLoad={onLoad} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

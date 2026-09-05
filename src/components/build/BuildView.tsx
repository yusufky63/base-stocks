"use client";

import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Repeat, Upload } from "lucide-react";
import type { Allocation, PortfolioTemplate } from "@/domain/portfolio";
import type { CommunityBasket } from "@/domain/community";
import { apiGet, apiPost, ApiError, type AssetsResponse } from "@/lib/client-api";
import { useAssets, useConfigFlags, useTemplates } from "@/hooks/queries";
import { useAuth } from "@/hooks/useAuth";
import { Module, ModuleHeader, Skeleton, Button, cx } from "@/components/ui/primitives";
import { Collapsible } from "@/components/ui/Collapsible";
import { Input } from "@/components/ui/Input";
import { AllocationEditor } from "./AllocationEditor";
import { PlanExecutor } from "./PlanExecutor";
import { AiIntentInput } from "./AiIntentInput";
import { TemplateCard } from "./TemplateCard";
import { partitionTemplates } from "@/lib/templates";
import { validateAllocations } from "@/services/portfolio-service";
import { automateHref } from "@/lib/automate-link";
import { Dither } from "@/components/fx/Dither";
import { SignInButton } from "@/components/layout/SignInButton";

type StartMode = "template" | "ai" | "scratch";

/**
 * Build in three moves: pick a starting point (template, AI draft or from scratch), adjust the
 * basket in the editor, invest with live quotes. Publishing is tucked under the editor; a basket
 * can also be handed to Automate to repeat on a schedule.
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
  const valid = validateAllocations(allocations).ok;

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
  });

  const load = (next: Allocation[], label: string, from: "template" | "ai") => {
    if (executing) return;
    setAllocations(next);
    setName(label);
    setSource(from);
    if (typeof document !== "undefined") document.getElementById("basket-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const MODES: Array<{ id: StartMode; label: string; hint: string }> = [
    { id: "ai", label: "AI draft", hint: "describe a theme" },
    { id: "template", label: "Template", hint: "ready-made mix, live stocks first" },
    { id: "scratch", label: "From scratch", hint: "pick stocks yourself" },
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
        <ModuleHeader
          index="A"
          title="Start with"
          action={
            <div role="tablist" aria-label="Starting point" className="flex gap-1 p-1 rounded-[8px] bg-surface-muted">
              {MODES.filter((m) => m.id !== "ai" || flags?.aiEnabled !== false).map((m) => (
                <button key={m.id} role="tab" aria-selected={activeMode === m.id} onClick={() => setMode(m.id)} className={cx("h-8 px-3 rounded-[6px] text-[12px] font-medium transition-fast whitespace-nowrap", activeMode === m.id ? "bg-canvas border border-line text-primary" : "text-ink-secondary hover:text-ink")} title={m.hint}>
                  {m.label}
                </button>
              ))}
            </div>
          }
        />
        <div className="p-4">
          {activeMode === "template" && <TemplateShelf templates={templates} assets={assets} onLoad={(tpl) => load(tpl.allocations, tpl.name, "template")} />}
          {activeMode === "ai" && <AiIntentInput onIntent={(intent) => load(intent.allocations, intent.name || "AI draft", "ai")} />}
          {activeMode === "scratch" && <p className="text-[13px] text-ink-secondary">Add stocks and a USDC share in the basket below; weights must total 100%.</p>}
        </div>
      </Module>

      <div id="basket-editor" className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-6 items-start scroll-mt-24">
        <Module ticks>
          <ModuleHeader
            index="B"
            title={name}
            action={<span className="font-mono text-[11px] text-ink-muted">{executing ? "locked while buying" : `${allocations.length} blocks${cloneId ? " · cloned" : ""}`}</span>}
          />
          <div className="p-4 flex flex-col gap-4">
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
                <Link href={automateHref(allocations, name)} className="inline-flex items-center gap-1.5 text-primary font-medium">
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
        <Module className="lg:sticky lg:top-[72px]">
          <ModuleHeader index="C" title="Invest" />
          <div className="p-4">
            <PlanExecutor allocations={allocations} source={source} disabled={!valid} onExecutingChange={setExecuting} />
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

"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Bot, Send, Trash2, X } from "lucide-react";
import { useConfigFlags } from "@/hooks/queries";
import { cx } from "@/components/ui/primitives";
import { AiQuotaNote } from "@/components/common/display";
import { useCopilot, type CopilotMessage } from "./CopilotProvider";
import { ActionCard } from "./ActionCards";
import { RichText } from "./RichText";

/**
 * The Copilot surface: a floating launcher and a non-modal panel (a modal dialog would inert the
 * page; the whole point is acting alongside it). Desktop: bottom-right card. Mobile: a bottom
 * sheet-like fixed panel above the tab bar.
 */
export function Copilot() {
  const flags = useConfigFlags();
  const { open, setOpen } = useCopilot();
  const path = usePathname();
  if (flags.data?.aiEnabled === false) return null;
  // The stock page's mobile Buy/Sell bar sits at bottom-14; the launcher climbs above it there.
  const onStockPage = path.startsWith("/stocks/");
  return (
    <>
      {!open && (
        <button
          type="button"
          aria-label="Open the assistant"
          onClick={() => setOpen(true)}
          className={cx(
            "fixed z-40 right-4 md:right-6 md:bottom-6 h-12 w-12 inline-flex items-center justify-center rounded-full bg-primary text-primary-contrast border border-primary-strong shadow-lg hover:brightness-[1.08] transition-fast",
            onStockPage ? "bottom-[calc(7.5rem+max(env(safe-area-inset-bottom),var(--miniapp-safe-bottom)))]" : "bottom-[calc(4.25rem+max(env(safe-area-inset-bottom),var(--miniapp-safe-bottom)))]",
          )}
        >
          <Bot size={22} strokeWidth={1.75} />
        </button>
      )}
      {open && <Panel onStockPage={onStockPage} />}
    </>
  );
}

function Panel({ onStockPage }: { onStockPage: boolean }) {
  const { setOpen, messages, sending, quota, send, clear } = useCopilot();
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, sending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const submit = () => {
    if (!input.trim() || sending) return;
    send(input);
    setInput("");
  };

  return (
    <div
      role="complementary"
      aria-label="Assistant"
      className={cx(
        "fixed z-40 flex flex-col bg-canvas border border-line rounded-t-[12px] md:rounded-[8px] shadow-xl",
        "inset-x-0 md:inset-x-auto md:right-6 md:bottom-6 md:w-[min(560px,calc(100vw-3rem))] md:h-[min(760px,88vh)] h-[85dvh]",
        onStockPage ? "bottom-[calc(3.5rem+max(env(safe-area-inset-bottom),var(--miniapp-safe-bottom)))] md:bottom-6" : "bottom-[calc(3.5rem+max(env(safe-area-inset-bottom),var(--miniapp-safe-bottom)))] md:bottom-6",
      )}
    >
      <div className="px-4 py-2.5 border-b border-line flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Bot size={16} strokeWidth={1.75} className="text-primary shrink-0" />
          <span className="eyebrow">Copilot</span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button type="button" aria-label="Clear the conversation" onClick={clear} className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink transition-fast">
              <Trash2 size={14} strokeWidth={1.75} />
            </button>
          )}
          <button type="button" aria-label="Close the assistant" onClick={() => setOpen(false)} className="h-8 w-8 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink transition-fast">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.length === 0 && <EmptyState onPick={(t) => send(t)} />}
        {messages.map((m, i) => (
          <Bubble key={i} message={m} />
        ))}
        {sending && (
          <div className="border-l-2 border-primary pl-3 py-1">
            <span className="inline-flex gap-1 items-center text-[13px] text-ink-muted">
              thinking
              <span className="animate-pulse">…</span>
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-line p-3 flex flex-col gap-1.5 shrink-0 [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] md:pb-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            maxLength={1_000}
            placeholder="Ask, or give an order to draft…"
            className="flex-1 resize-none rounded-[6px] border border-line bg-canvas px-3 py-2 text-[14px] leading-snug outline-none focus:border-primary transition-fast max-h-28"
          />
          <button type="button" aria-label="Send" onClick={submit} disabled={sending || !input.trim()} className="h-9 w-9 shrink-0 inline-flex items-center justify-center rounded-[6px] bg-primary text-primary-contrast disabled:opacity-40 hover:brightness-[1.08] transition-fast">
            <Send size={15} strokeWidth={1.75} />
          </button>
        </div>
        <p className="text-[10px] leading-snug text-ink-muted">
          Drafts are templates, not advice. Every action needs your wallet signature. <AiQuotaNote remaining={quota} className="text-[10px]" />
        </p>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: CopilotMessage }) {
  if (message.role === "user") {
    return <div className="self-end max-w-[85%] rounded-[8px] bg-primary-soft text-ink px-3 py-2 text-[13px] whitespace-pre-wrap break-words">{message.content}</div>;
  }
  return (
    <div className={cx("self-start max-w-full border-l-2 pl-3 py-0.5", message.error ? "border-danger" : "border-primary")}>
      {message.error ? <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-danger-fg">{message.content}</p> : <RichText text={message.content} />}
      {message.actions?.map((a, i) => <ActionCard key={i} action={a} />)}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const suggestions = ["What's in my portfolio?", "Any NVDA news today?", "Buy $50 of NVDA", "Build me a balanced tech basket", "Invest $50 in TSLA every week"];
  return (
    <div className="flex flex-col gap-2 my-auto">
      <p className="text-[13px] text-ink-secondary">Ask about prices, news, your portfolio or Earn — or give an order and review the draft before signing.</p>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="h-7 px-2.5 rounded-full border border-line text-[12px] text-ink-secondary hover:text-primary hover:border-primary transition-fast">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

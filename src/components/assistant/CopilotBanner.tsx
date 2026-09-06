"use client";

import { useAccount } from "wagmi";
import { ArrowRight, Bot } from "lucide-react";
import { useConfigFlags } from "@/hooks/queries";
import { cx } from "@/components/ui/primitives";
import { useCopilot } from "./CopilotProvider";

/**
 * The assistant's front door on the home page: one line about what it does and a few real
 * questions that open the panel already answering. Hidden when AI is off on this deployment.
 */
export function CopilotBanner({ className }: { className?: string }) {
  const flags = useConfigFlags();
  const { setOpen, send } = useCopilot();
  const { isConnected } = useAccount();
  if (flags.data?.aiEnabled === false) return null;

  const prompts = isConnected
    ? ["How is my portfolio doing?", "Any news on my stocks?", "Buy $50 of NVDA", "Build me a balanced tech basket"]
    : ["What moved today?", "Any Base ecosystem news?", "Buy $50 of NVDA", "Build me a balanced tech basket"];

  const ask = (text: string) => {
    setOpen(true);
    send(text);
  };

  return (
    <section className={cx("border border-line rounded-[8px] bg-canvas ticks overflow-hidden", className)}>
      <div className="p-4 md:p-5 flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <span aria-hidden className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-[8px] bg-primary-soft text-primary border border-primary/30">
            <Bot size={20} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <div className="eyebrow mb-1">Copilot · ask anything</div>
            <p className="text-[14px] md:text-[15px] text-ink leading-snug">
              Skip the menus. Ask about prices, news, your portfolio or Earn — or just say <span className="font-medium">&ldquo;buy $50 of NVDA&rdquo;</span> and review the draft before you sign.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="shrink-0 h-11 px-4 inline-flex items-center justify-center gap-2 rounded-[6px] text-[14px] font-medium bg-primary text-primary-contrast border border-primary-strong border-b-[3px] border-b-black/30 hover:brightness-[1.08] active:border-b active:translate-y-[2px] transition-fast"
        >
          Start chatting <ArrowRight size={15} strokeWidth={1.75} />
        </button>
      </div>
      <div className="px-4 md:px-5 pb-4 flex flex-wrap gap-1.5">
        {prompts.map((p) => (
          <button key={p} type="button" onClick={() => ask(p)} className="h-8 px-3 rounded-full border border-line text-[12.5px] text-ink-secondary hover:text-primary hover:border-primary transition-fast">
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}

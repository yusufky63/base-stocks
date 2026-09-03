"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "./primitives";

export function Collapsible({ title, children, defaultOpen = false, className }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cx("border-t border-line", className)}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="w-full min-h-[44px] flex items-center justify-between py-3 text-[13px] font-medium text-ink-secondary hover:text-ink">
        <span>{title}</span>
        <ChevronDown size={16} strokeWidth={1.75} className={cx("transition-fast transition-transform", open && "rotate-180")} />
      </button>
      <div id={id} hidden={!open} className="pb-3 anim-fade">
        {children}
      </div>
    </div>
  );
}

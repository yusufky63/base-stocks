"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cx } from "./primitives";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Prevent closing while a wallet action is in flight. */
  locked?: boolean;
  footer?: ReactNode;
  wide?: boolean;
}

/**
 * Accessible sheet: native <dialog> (focus trap, Esc, backdrop), bottom sheet on mobile,
 * centered dialog on desktop. Radius 12px, restrained depth shadow only here (spec §53).
 */
export function Sheet({ open, onClose, title, children, locked, footer, wide }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (!locked) onClose();
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [locked, onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="sheet-title"
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose();
      }}
      className={cx(
        "m-0 p-0 w-full bg-canvas text-ink border border-line",
        "fixed inset-x-0 bottom-0 top-auto max-h-[92dvh] rounded-t-[12px] max-w-none",
        "md:inset-0 md:m-auto md:rounded-[12px] md:max-h-[90vh] md:shadow-[0_24px_64px_rgba(10,11,13,0.25)]",
        wide ? "md:max-w-[720px]" : "md:max-w-[480px]",
        "open:anim-rise",
      )}
    >
      <div className="flex flex-col max-h-[92dvh] md:max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="sheet-title" className="display text-[20px]">
            {title}
          </h2>
          <button type="button" aria-label="Close" disabled={locked} onClick={onClose} className="h-11 w-11 -mr-3 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink disabled:opacity-40">
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-line bg-canvas [padding-bottom:max(16px,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </dialog>
  );
}
